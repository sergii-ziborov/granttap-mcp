import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseClaudeFile } from "../../parse";

const SESSION = "claude-waits";
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const row = (type: string, offsetMs: number, message?: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ sessionId: SESSION, type, timestamp: at(offsetMs), message, ...extra });
const launch = (offsetMs: number, id: string, name = "Bash", input: Record<string, unknown> = { run_in_background: true }) =>
  row("assistant", offsetMs, { role: "assistant", stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name, input: { command: "synthetic", ...input } }] });
const result = (offsetMs: number, id: string, text: string, extra: Record<string, unknown> = {}) =>
  row("user", offsetMs, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, ...extra }] });
const ended = (offsetMs: number) =>
  row("assistant", offsetMs, { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Waiting for the gate." }] });
const notification = (offsetMs: number, tags: string) =>
  row("queue-operation", offsetMs, undefined, { operation: "enqueue", content: `<task-notification>\n${tags}\n</task-notification>` });

function transcript(rows: string[]): { file: string; done: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "granttap-claude-waits-"));
  const file = join(directory, `${SESSION}.jsonl`);
  writeFileSync(file, rows.join("\n") + "\n");
  return { file, done: () => rmSync(directory, { recursive: true, force: true }) };
}

test("a turn that ended with its background command still running waits on it, not on the person", () => {
  const log = transcript([
    row("user", -60_000, { role: "user", content: "Synthetic request" }),
    launch(-50_000, "toolu_gate"),
    result(-49_000, "toolu_gate", "Command running in background with ID: bgate1. Output is being written to: /tmp/x"),
    ended(-48_000),
  ]);
  try {
    const waiting = parseClaudeFile(log.file)?.session;
    assert.equal(waiting?.state, "idle");
    assert.equal(waiting?.backgroundTasks, 1, "the chat resumes itself when the gate finishes");
    appendFileSync(log.file, notification(-2_000,
      "<task-id>bgate1</task-id>\n<tool-use-id>toolu_gate</tool-use-id>\n<status>completed</status>") + "\n");
    appendFileSync(log.file, ended(-1_000) + "\n");
    const done = parseClaudeFile(log.file)?.session;
    assert.equal(done?.state, "idle");
    assert.equal(done?.backgroundTasks, undefined, "its notification arrived, so nothing is outstanding");
  } finally { log.done(); }
});

test("a stopped task, a foreground agent, a failed launch and an expired command leave nothing outstanding", () => {
  const log = transcript([
    launch(-30_000, "toolu_agent", "Agent", {}),
    result(-29_000, "toolu_agent", "Async agent launched successfully. agentId: a1b2c3d4 (internal)"),
    notification(-20_000, "<task-id>a1b2c3d4</task-id>\n<status>stopped</status>"),
    launch(-19_000, "toolu_sync", "Agent", {}),
    result(-18_000, "toolu_sync", "The subagent finished: synthetic answer."),
    launch(-17_000, "toolu_broken"),
    result(-16_000, "toolu_broken", "Command running in background with ID: bbroken.", { is_error: true }),
    launch(-11 * 60_000, "toolu_old"),
    result(-11 * 60_000 + 500, "toolu_old", "Command running in background with ID: bold."),
    launch(-15_000, "toolu_side"),
    result(-14_000, "toolu_side", "Command running in background with ID: bside.", {}),
    ended(-1_000),
  ].map(line => line.includes("toolu_side") ? line.replace('"type":"', '"isSidechain":true,"type":"') : line));
  try {
    const session = parseClaudeFile(log.file)?.session;
    assert.equal(session?.state, "idle");
    assert.equal(session?.backgroundTasks, undefined);
  } finally { log.done(); }
});

test("a turn cut off by the subscription limit says when the limit resets, until the next prompt", () => {
  const resetsAt = Math.floor((Date.now() + 2 * 3_600_000) / 1_000);
  const log = transcript([
    row("user", -10_000, { role: "user", content: "Synthetic request" }),
    row("assistant", -5_000, { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your 5-hour limit · resets 12:30pm" }] },
    { isApiErrorMessage: true, error: "rate_limit", apiError: "usage_limit_reached", apiErrorStatus: 429,
      quotaLimits: { status: "rejected", resetsAt, rateLimitType: "five_hour" } }),
  ]);
  try {
    const limited = parseClaudeFile(log.file)?.session;
    assert.equal(limited?.state, "idle");
    assert.deepEqual(limited?.usageLimit, { resetsAt: resetsAt * 1_000, window: "five_hour" });
    appendFileSync(log.file, row("user", -1_000, { role: "user", content: "Synthetic follow-up" }) + "\n");
    const resumed = parseClaudeFile(log.file)?.session;
    assert.equal(resumed?.state, "working");
    assert.equal(resumed?.usageLimit, undefined, "a new turn is no longer the limited one");
  } finally { log.done(); }
});

test("a transient overload is not a subscription limit", () => {
  const log = transcript([
    row("assistant", -5_000, { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "API Error: 429 rate_limit" }] },
    { isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429 }),
  ]);
  try { assert.equal(parseClaudeFile(log.file)?.session.usageLimit, undefined); }
  finally { log.done(); }
});
