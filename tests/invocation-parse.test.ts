import assert from "node:assert/strict";
import test from "node:test";
import { parseInvocationLine, type InvocationParseState } from "../apps/bridge/src/engine/invocation-parse";

function state(): InvocationParseState { return { pending: new Map() }; }

test("Claude, Codex and Cursor retain each native call and its reported outcome", () => {
  const claude = state();
  const use = JSON.stringify({ timestamp: "2026-09-14T10:00:00Z", message: { content: [
    { type: "tool_use", id: "call-a", name: "Edit", input: { file_path: "/repo/src/a.ts", content: "private" } },
  ] } });
  const result = JSON.stringify({ timestamp: "2026-09-14T10:00:01Z", message: { content: [
    { type: "tool_result", tool_use_id: "call-a", is_error: true, content: "private failure" },
  ] } });
  assert.deepEqual(parseInvocationLine("claude", use, claude, 1).map((fact) => [fact.callId, fact.phase, fact.resource]),
    [["call-a", "requested", "/repo/src/a.ts"]]);
  assert.deepEqual(parseInvocationLine("claude", result, claude, 2).map((fact) => [fact.callId, fact.phase]),
    [["call-a", "reported_failure"]]);
  assert.equal(claude.pending.size, 0);

  const codex = state();
  const call = JSON.stringify({ type: "response_item", timestamp: "2026-09-14T10:00:00Z", payload: {
    type: "function_call", call_id: "call-b", name: "apply_patch", arguments: "{}",
  } });
  const output = JSON.stringify({ type: "response_item", timestamp: "2026-09-14T10:00:01Z", payload: {
    type: "function_call_output", call_id: "call-b", output: "private result",
  } });
  assert.deepEqual(parseInvocationLine("codex", call, codex, 3).map((fact) => [fact.callId, fact.phase]),
    [["call-b", "requested"]]);
  assert.deepEqual(parseInvocationLine("codex", output, codex, 4).map((fact) => [fact.callId, fact.phase]),
    [["call-b", "reported_unknown"]]);

  const cursor = state();
  assert.deepEqual(parseInvocationLine("cursor", use, cursor, 5).map((fact) => [fact.callId, fact.phase]),
    [["call-a", "requested"]]);
  assert.deepEqual(parseInvocationLine("cursor", result, cursor, 6).map((fact) => [fact.callId, fact.phase]),
    [["call-a", "reported_failure"]]);
});

test("an orphan result is an explicit source gap, never a success for an invented call", () => {
  const result = JSON.stringify({ message: { content: [
    { type: "tool_result", tool_use_id: "missing", content: "secret" },
  ] } });
  assert.deepEqual(parseInvocationLine("claude", result, state(), 100).map((fact) => fact.phase),
    ["source_gap"]);
});

test("Codex raw apply_patch records only target paths, never patch content", () => {
  const row = JSON.stringify({ type: "response_item", payload: {
    type: "function_call", call_id: "patch-1", name: "apply_patch",
    arguments: "*** Begin Patch\n*** Update File: src/a.ts\n+private material\n*** End Patch",
  } });
  const facts = parseInvocationLine("codex", row, state(), 1);
  assert.deepEqual(facts.map((fact) => fact.resource), ["src/a.ts"]);
  assert.equal(JSON.stringify(facts).includes("private material"), false);
});
