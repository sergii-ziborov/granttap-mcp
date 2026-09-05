import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.GRANTTAP_MCP_NO_MAIN = "1";
const { exitWhenAgentLeaves } = await import("../apps/mcp/src/server");

test("an MCP server leaves once, when the agent that started it closes the pipe", () => {
  const input = new EventEmitter();
  const codes: number[] = [];
  exitWhenAgentLeaves(input as unknown as NodeJS.ReadableStream, (code) => codes.push(code));
  assert.deepEqual(codes, [], "alive while the pipe is open");
  input.emit("end");
  input.emit("close");
  assert.deepEqual(codes, [0], "one exit, whichever event comes second");
});
