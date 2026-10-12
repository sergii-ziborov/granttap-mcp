import assert from "node:assert/strict";
import test from "node:test";
import { claudeToRequest } from "../../adapters";

test("MCP approvals retain inspectable parameters and describe batch actions", () => {
  const request = claudeToRequest({ tool_name: "mcp__Claude_Browser__browser_batch",
    tool_input: { actions: [{ action: "navigate", url: "https://example.test" },
      { action: "click", selector: "Save" }] } });
  assert.match(request.title, /navigate/);
  assert.match(request.title, /click/);
  assert.match(request.details!, /example.test/);
  assert.match(request.details!, /Save/);
});

test("Approval details redact credentials and bound large provider input", () => {
  const request = claudeToRequest({ tool_name: "mcp__browser__batch", tool_input: {
    authorization: "Bearer swordfish", nested: { api_key: "swordfish" },
    url: "https://user:swordfish@example.test?token=swordfish&mode=edit",
    actions: Array.from({ length: 200 }, () => ({ script: "x".repeat(4_000) })),
  } });
  assert.ok(request.details);
  assert.equal(request.details.includes("swordfish"), false);
  assert.ok(request.details.length <= 16_384);
});
