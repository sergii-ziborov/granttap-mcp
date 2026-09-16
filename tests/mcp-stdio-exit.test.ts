import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.GRANTTAP_MCP_NO_MAIN = "1";
const { exitWhenAgentLeaves } = await import("../apps/mcp/src/server");

test("an MCP server leaves once, when the agent that started it closes the pipe", () => {
  const input = Object.assign(new EventEmitter(), { readableEnded: true });
  const codes: number[] = [];
  exitWhenAgentLeaves(input as unknown as NodeJS.ReadableStream, (code) => codes.push(code));
  assert.deepEqual(codes, [], "alive while the pipe is open");
  input.emit("end");
  input.emit("close");
  assert.deepEqual(codes, [0], "one exit, whichever event comes second");
});

test("a Windows stdin close without EOF does not tear the MCP server down", () => {
  const input = Object.assign(new EventEmitter(), { readableEnded: false });
  const codes: number[] = [];
  exitWhenAgentLeaves(input as unknown as NodeJS.ReadableStream, (code) => codes.push(code));
  input.emit("close");
  assert.deepEqual(codes, []);
});
