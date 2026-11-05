import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { createMcpSessionHandler } from "../mcp-handler";

test("stale HTTP MCP session returns 404 so the client can initialize again", async () => {
  const handler = createMcpSessionHandler();
  const stale = captureResponse();
  await handler.handler({ method: "POST", headers: { "mcp-session-id": "ended-session" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" } } as unknown as Request, stale.response);
  assert.equal(stale.status(), 404);
  assert.deepEqual(stale.body(), { jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" }, id: null });

  const missing = captureResponse();
  await handler.handler({ method: "POST", headers: {},
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" } } as unknown as Request, missing.response);
  assert.equal(missing.status(), 400);
  await handler.close();
});

function captureResponse() {
  let status = 0;
  let body: unknown;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as Response;
  return { response, status: () => status, body: () => body };
}
