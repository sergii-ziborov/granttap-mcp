import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveRuntimeConfig } from "../../../config";
import { cursorInteractions } from "../interactions";

const scope = { sessionId: "fixture-task", cwd: "/fixture" };
const cancelled = { outcome: { outcome: "cancelled" } };
const question = { toolCallId: "question", questions: [{ id: "next", prompt: "Next?",
  options: [{ id: "test", label: "Test" }] }] };
const permission = { sessionId: scope.sessionId, toolCall: { toolCallId: "shell", title: "Fixture command",
  kind: "execute", rawInput: { command: "printf fixture" } }, options: [
    { optionId: "allow", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] };

test("unscoped, malformed and foreign-session Cursor questions cannot reach a phone form", async () => {
  let asked = 0;
  const ask = async () => { asked++; throw new Error("Unexpected form"); };
  const signal = new AbortController().signal;
  assert.deepEqual(await cursorInteractions(() => ({ ...scope, sessionId: "" }), "turn", 1_000, ask)
    ("cursor/ask_question", question, signal), cancelled);
  const handler = cursorInteractions(() => scope, "turn", 1_000, ask);
  for (const params of [{}, { ...question, sessionId: "foreign" }]) {
    assert.deepEqual(await handler("cursor/ask_question", params, signal), cancelled);
  }
  assert.deepEqual(await handler("cursor/create_plan", { toolCallId: "p", plan: "Plan", sessionId: "foreign" }, signal), cancelled);
  assert.equal(asked, 0);
});

test("computer denials override Cursor permission choices and task auto-accept", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-cursor-deny-")), previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  saveRuntimeConfig({ sessionShellDisabled: [scope.sessionId], autoAcceptBySession: { [scope.sessionId]: "full" } });
  const handler = cursorInteractions(() => scope, "turn", 1_000, async () => { throw new Error("Deny must win"); });
  assert.deepEqual(await handler("session/request_permission", permission, new AbortController().signal),
    { outcome: { outcome: "selected", optionId: "reject" } });
  assert.deepEqual(await handler("session/request_permission", { ...permission,
    toolCall: { ...permission.toolCall, kind: "edit", rawInput: {} } }, new AbortController().signal), cancelled);
});

test("an answer received after Task Stop cannot satisfy a Cursor question", async () => {
  const controller = new AbortController();
  const handler = cursorInteractions(() => scope, "turn", 1_000, async request => {
    controller.abort();
    return { type: "approval.decision", requestId: request.requestId, sessionId: request.sessionId,
      decision: "allow", note: '{"Next?":"Test"}', decidedAt: Date.now() };
  });
  assert.deepEqual(await handler("_cursor/ask_question", question, controller.signal), cancelled);
});

test("a computer denial added while the phone form is open overrides the later Allow", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-cursor-policy-change-")), previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true }); });
  saveRuntimeConfig({ autoAcceptBySession: { [scope.sessionId]: "ask" } });
  const handler = cursorInteractions(() => scope, "turn", 1_000, async request => {
    saveRuntimeConfig({ sessionShellDisabled: [scope.sessionId] });
    return { type: "approval.decision", requestId: request.requestId, sessionId: request.sessionId,
      decision: "allow", decidedAt: Date.now() };
  });
  assert.deepEqual(await handler("session/request_permission", permission, new AbortController().signal),
    { outcome: { outcome: "selected", optionId: "reject" } });
});

test("a migrated Cursor execution asks and answers within its original GrantTap Task", async () => {
  const mapped = { ...scope, nativeSessionId: "interactive-execution" };
  const handler = cursorInteractions(() => mapped, "turn", 1_000, async request => {
    assert.equal(request.sessionId, scope.sessionId);
    return { type: "approval.decision", requestId: request.requestId, sessionId: scope.sessionId,
      decision: "allow", note: '{"Next?":"Test"}', decidedAt: Date.now() };
  });
  assert.deepEqual(await handler("cursor/ask_question", { ...question, sessionId: mapped.nativeSessionId },
    new AbortController().signal), { outcome: { outcome: "answered", answers: [{ questionId: "next", selectedOptionIds: ["test"] }] } });
});
