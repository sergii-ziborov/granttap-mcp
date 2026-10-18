import assert from "node:assert/strict";
import test from "node:test";
import { CursorCallContext } from "../index";

test("native permission metadata joins only the same session, call and action kind", () => {
  const calls = new CursorCallContext();
  const update = { sessionId: "task", update: { sessionUpdate: "tool_call", toolCallId: "shell-1",
    kind: "execute", rawInput: { command: "printf fixture" } } };
  const permission = { sessionId: "task", toolCall: { toolCallId: "shell-1", kind: "execute", title: "Fixture" } };
  calls.remember(update, "task");
  assert.deepEqual(calls.permission(permission, "task"), { ...permission,
    toolCall: { ...permission.toolCall, rawInput: update.update.rawInput, locations: undefined } });
  for (const value of [{ ...permission, sessionId: "foreign" }, { ...permission,
    toolCall: { ...permission.toolCall, kind: "edit" } }, { ...permission,
    toolCall: { ...permission.toolCall, toolCallId: "other" } }]) {
    assert.deepEqual(calls.permission(value, "task"), value);
  }
  calls.remember({ ...update, sessionId: "foreign", update: { ...update.update, rawInput: { command: "wrong" } } }, "task");
  assert.equal((calls.permission(permission, "task") as typeof update & { toolCall: { rawInput: { command: string } } }).toolCall.rawInput.command,
    "printf fixture");
});

test("unbounded native action metadata is discarded rather than displayed or approved", () => {
  const calls = new CursorCallContext();
  calls.remember({ sessionId: "task", update: { sessionUpdate: "tool_call", toolCallId: "huge", kind: "execute",
    rawInput: { command: "x".repeat(70_000) } } }, "task");
  const permission = { sessionId: "task", toolCall: { toolCallId: "huge", kind: "execute" } };
  assert.deepEqual(calls.permission(permission, "task"), permission);
});
