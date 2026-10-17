import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseClaudeFile } from "../scan/claude/parse";

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const row = (type: string, offsetMs: number, message?: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ sessionId: "claude-turn-state", type, timestamp: at(offsetMs), message, ...extra });

function transcript(rows: string[]): { file: string; done: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "granttap-claude-turn-"));
  const file = join(directory, "claude-turn-state.jsonl");
  writeFileSync(file, rows.join("\n") + "\n");
  return { file, done: () => rmSync(directory, { recursive: true, force: true }) };
}

test("a Claude chat whose last answer ended its turn is idle at once, not 90 seconds later", () => {
  const log = transcript([
    row("user", -20_000, { role: "user", content: "Synthetic question" }),
    row("assistant", -5_000, { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] }),
    JSON.stringify({ type: "last-prompt", sessionId: "claude-turn-state" }),
  ]);
  try {
    assert.equal(parseClaudeFile(log.file)?.session.state, "idle",
      "a queued phone message must not wait for a quiet window after a finished turn");
    appendFileSync(log.file, row("user", -1_000, { role: "user", content: "Next synthetic question" }) + "\n");
    assert.equal(parseClaudeFile(log.file)?.session.state, "working", "a new prompt starts a new turn");
  } finally { log.done(); }
});

test("a Claude chat waiting on a tool or a queued prompt keeps the recent-activity rule", () => {
  const tool = transcript([
    row("user", -20_000, { role: "user", content: "Synthetic question" }),
    row("assistant", -5_000, { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] }),
  ]);
  const queued = transcript([
    row("assistant", -5_000, { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] }),
    row("queue-operation", -1_000, undefined, { operation: "enqueue" }),
  ]);
  const sidechain = transcript([
    row("assistant", -6_000, { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] }),
    row("user", -4_000, { role: "user", content: "Synthetic sidechain prompt" }, { isSidechain: true }),
  ]);
  try {
    assert.equal(parseClaudeFile(tool.file)?.session.state, "working");
    assert.equal(parseClaudeFile(queued.file)?.session.state, "working");
    assert.equal(parseClaudeFile(sidechain.file)?.session.state, "idle", "a subagent line is not the chat's own turn");
  } finally { tool.done(); queued.done(); sidechain.done(); }
});
