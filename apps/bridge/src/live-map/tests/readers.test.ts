import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeObservation } from "../readers/claude";
import { codexObservation, codexOutcome } from "../readers/codex";
import { entriesObservation } from "../readers/entries";
import { tailLines } from "../readers/shared";

const MARK = "SECRET-MARK-91c2";
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, seconds)).toISOString();
const rows = (...items: unknown[]) => items.map(item => JSON.stringify(item));

const assistant = (seconds: number, id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "assistant", timestamp: at(seconds), message: { id, model: "claude-opus-5-5", role: "assistant", content,
    usage: { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5 }, ...extra } });
const result = (seconds: number, id: string, isError = false, text = "done") => ({ type: "user", timestamp: at(seconds),
  uuid: `r-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } });

test("a Claude chat's rows become calls, steps, messages and its answer", () => {
  const observation = claudeObservation(rows(
    { type: "user", timestamp: at(0), uuid: "u1", message: { role: "user", content: `please ${MARK}` } },
    assistant(1, "m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `curl https://${MARK}.test` } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: `/${MARK}/a.ts` } }]),
    result(3, "t1", true, "The user doesn't want to proceed with this tool use."),
    result(4, "t2"),
    assistant(5, "m2", [{ type: "tool_use", id: "t3", name: "Agent", input: { subagent_type: "Explore", prompt: MARK } }]),
    { type: "system", subtype: "compact_boundary", timestamp: at(6), uuid: "c1" },
    { ...assistant(7, "m3", [{ type: "text", text: MARK }], { stop_reason: "end_turn" }), isSidechain: true, agentId: "side" },
    assistant(8, "m4", [{ type: "text", text: MARK }], { stop_reason: "end_turn", model: "claude-fable-5-2" }),
    { type: "user", timestamp: at(9), message: { role: "user", content: "<task-notification><status>completed</status></task-notification>" } },
    "not json",
  ));
  const tools = observation.calls.filter(call => !call.mark);
  assert.deepEqual(tools.map(call => [call.name, call.station, call.status]),
    [["Bash", "web", "blocked"], ["Read", "files", "ok"], ["Explore", "agents", "run"]]);
  assert.equal(tools[1]!.endedAt! - tools[1]!.startedAt, 3_000);
  assert.deepEqual(observation.calls.filter(call => call.mark).map(call => call.mark),
    ["message", "step", "step", "compact", "step", "model", "step", "answer"]);
  assert.equal(observation.calls.find(call => call.mark === "model")?.model, "claude-fable-5-2");
  assert.equal(observation.calls.find(call => call.key.startsWith("step:side"))?.agentKey, "side");
  assert.equal(observation.model, "claude-fable-5-2");
  assert.deepEqual(observation.context, { usedTokens: 90_015 });
  assert.deepEqual(observation.agents, ["t3"]);
  assert.equal(JSON.stringify(observation).includes(MARK), false);
});

test("a Claude subagent's own file adds its calls under its id", () => {
  const observation = claudeObservation(rows(assistant(1, "m1", [{ type: "tool_use", id: "a1", name: "Agent", input: {} }])),
    [{ agentKey: "agent-x", lines: rows(assistant(2, "s1", [{ type: "tool_use", id: "s-t1", name: "Grep", input: {} }])) }]);
  const child = observation.calls.find(call => call.key === "s-t1");
  assert.equal(child?.agentKey, "agent-x");
  assert.equal(child?.station, "files");
  assert.deepEqual(observation.agents, ["a1"]);
});

test("a Codex rollout's rows become calls with outcomes, model changes and the context share", () => {
  const event = (seconds: number, payload: unknown) => ({ timestamp: at(seconds), type: "event_msg", payload });
  const item = (seconds: number, payload: unknown) => ({ timestamp: at(seconds), type: "response_item", payload });
  const observation = codexObservation(rows(
    { timestamp: at(0), type: "turn_context", payload: { model: "gpt-6-codex" } },
    event(0, { type: "user_message", message: MARK }),
    item(1, { type: "reasoning", id: "r1" }),
    item(1, { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: `rg ${MARK}` }) }),
    item(2, { type: "function_call_output", call_id: "c1", output: "Exit code: 0\nOutput: x" }),
    item(2, { type: "function_call", name: "exec_command", call_id: "c2", arguments: "{\"cmd\":\"npm test\"}" }),
    event(4, { type: "exec_command_end", call_id: "c2", exit_code: 1 }),
    item(4, { type: "custom_tool_call", name: "apply_patch", call_id: "c3", input: `*** Update File: ${MARK}` }),
    item(5, { type: "custom_tool_call_output", call_id: "c3", output: "{\"output\":\"x\",\"metadata\":{\"exit_code\":0}}" }),
    item(5, { type: "local_shell_call", call_id: "c4", status: "completed", action: { command: ["ls"] } }),
    item(6, { type: "web_search_call", id: "w1", status: "completed", action: { query: MARK } }),
    item(6, { type: "function_call", name: "ask", namespace: "mcp__granttap", call_id: "c5", arguments: "{}" }),
    { timestamp: at(7), type: "turn_context", payload: { model: "gpt-6-luna" } },
    event(7, { type: "token_count", info: { last_token_usage: { input_tokens: 200_000, cached_input_tokens: 1 },
      model_context_window: 250_000 } }),
    item(8, { type: "message", role: "assistant", phase: "final_answer", id: "f1", content: [{ type: "output_text", text: MARK }] }),
    event(8, { type: "task_complete" }),
    { timestamp: at(9), type: "compacted", payload: { message: MARK } },
  ));
  assert.deepEqual(observation.calls.filter(call => !call.mark).map(call => [call.name, call.station, call.status]), [
    ["exec command", "files", "ok"], ["exec command", "shell", "error"], ["apply patch", "files", "ok"],
    ["local shell call", "files", "ok"], ["web search", "web", "ok"], ["granttap: ask", "you", "run"],
  ]);
  assert.deepEqual(observation.calls.filter(call => call.mark).map(call => call.mark),
    ["message", "step", "model", "answer", "compact"]);
  assert.equal(observation.model, "gpt-6-luna");
  assert.deepEqual(observation.context, { usedTokens: 200_000, windowTokens: 250_000 });
  assert.equal(JSON.stringify(observation).includes(MARK), false);
});

test("a Codex output says how its call ended by exit code or refusal only", () => {
  assert.equal(codexOutcome("Process exited with code 2"), "error");
  assert.equal(codexOutcome("exec rejected by user"), "blocked");
  assert.equal(codexOutcome("error: no such file"), "error");
  assert.equal(codexOutcome("Error: blocked by policy"), "blocked");
  assert.equal(codexOutcome({ ok: true }), "ok");
  assert.equal(codexOutcome(undefined), "ok");
  assert.equal(codexOutcome("{\"metadata\":{\"exit_code\":3}}"), "error");
});

test("Cursor and Grok calls come from the rows GrantTap already reads", () => {
  const entries = [
    { id: "u", kind: "user" as const, text: MARK, createdAt: 1_000 },
    { id: "t1", kind: "tool" as const, toolName: "Shell", text: `Shell: curl ${MARK}`, createdAt: 2_000 },
    { id: "t2", kind: "tool" as const, toolName: "Read", text: "Read", createdAt: 3_000, outcome: "error" as const },
    { id: "t3", kind: "tool" as const, toolName: "Edit", text: "Edit", createdAt: 4_000, durationMs: 50, childThreadId: "k" },
    { id: "t4", kind: "tool" as const, toolName: "Edit", text: "Edit", createdAt: 4_500, outcome: "cancelled" as const },
    { id: "m", kind: "message" as const, text: MARK, createdAt: 5_000 },
    { id: "f", kind: "final" as const, text: MARK, createdAt: 6_000 },
  ];
  const cursor = entriesObservation({ agent: "cursor", model: "composer-2" }, entries);
  assert.deepEqual(cursor.calls.filter(call => !call.mark).map(call => [call.station, call.status, call.agentKey]),
    [["web", "run", undefined], ["files", "error", undefined], ["files", "ok", "k"], ["files", "blocked", undefined]]);
  assert.equal(cursor.calls.find(call => call.key === "t3")?.endedAt, 4_050);
  assert.deepEqual(cursor.calls.filter(call => call.mark).map(call => call.mark), ["message", "step", "answer"]);
  assert.equal(cursor.model, "composer-2");
  const grok = entriesObservation({ agent: "grok" }, entries.slice(1, 2));
  assert.equal(grok.calls[0]?.status, "ok");
  assert.equal(JSON.stringify(cursor).includes(MARK), false);
});

test("a tail read keeps whole lines from the end of the file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "granttap-live-map-tail-")), "log.jsonl");
  writeFileSync(path, "first line\nsecond\nthird\n");
  assert.deepEqual(tailLines(path, 1_000), ["first line", "second", "third"]);
  assert.deepEqual(tailLines(path, 13), ["second", "third"]);
  assert.deepEqual(tailLines(path, 12), ["third"]);
  assert.equal(tailLines(join(path, "missing"), 10), undefined);
});

test("a Claude call started in the background runs until the host's notice that it is done", () => {
  const notice = (id: string, status: string) =>
    `<task-notification>\n<task-id>b${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n`
    + `<summary>Background command "${MARK}" ${status}</summary>\n</task-notification>`;
  const started = rows(
    assistant(1, "m1", [
      { type: "tool_use", id: "build", name: "Bash", input: { command: `xcodebuild ${MARK}`, run_in_background: true } },
      { type: "tool_use", id: "tests", name: "Bash", input: { command: "npm test", run_in_background: true } },
      { type: "tool_use", id: "quick", name: "Bash", input: { command: "ls" } }]),
    result(2, "build", false, "Command running in background with ID: bbuild."),
    result(2, "tests", false, "Command running in background with ID: btests."),
    result(2, "quick"),
  );
  const now = Date.parse(at(30));
  const running = claudeObservation(started, [], now).calls.filter(call => call.status === "run").map(call => call.key);
  assert.deepEqual(running, ["build", "tests"], "a background command is still at work after it answers");

  const done = claudeObservation([...started,
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: at(40), content: notice("build", "completed") }),
    JSON.stringify({ type: "user", timestamp: at(50), message: { role: "user", content: notice("tests", "failed") } }),
  ], [], now);
  const byKey = new Map(done.calls.map(call => [call.key, call]));
  assert.equal(byKey.get("build")?.status, "ok");
  assert.equal(byKey.get("build")!.endedAt! - byKey.get("build")!.startedAt, 39_000);
  assert.equal(byKey.get("tests")?.status, "error");
  assert.equal(JSON.stringify(done).includes(MARK), false);

  const forgotten = claudeObservation(started, [], Date.parse(at(1)) + 3 * 60 * 60_000);
  assert.deepEqual(forgotten.calls.filter(call => call.status === "run"), [], "a notice that never came stops counting after two hours");
});
