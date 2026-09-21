import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configuredProjectMcpServers, mergeConfiguredMcpServers,
} from "../../../apps/bridge/src/mesh/catalog/project/configured-mcp";

test("a bound workspace reports configured MCP before any native chat exists", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-configured-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".cursor"));
  writeFileSync(join(root, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: { "project-review": { command: "review-server" } },
  }));
  const rows = configuredProjectMcpServers("local-mac", [root], ["cursor"]);
  const review = rows.find((row) => row.name === "project-review");
  assert.equal(review?.endpointId, "local-mac");
  assert.deepEqual(review?.sessionIds, []);
  assert.equal(review?.configuredEnabled, true);
  assert.equal(review?.version, undefined);
});

test("same MCP name with different native commands across Project workspaces conflicts", (t) => {
  const roots = ["first", "second"].map((label) =>
    mkdtempSync(join(tmpdir(), `granttap-mcp-${label}-`)));
  t.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
  for (const [index, root] of roots.entries()) {
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: { "project-index": { command: `index-${index}` } },
    }));
  }
  const rows = configuredProjectMcpServers("mac", roots, ["cursor"]);
  const index = rows.find((row) => row.name === "project-index");
  assert.equal(index?.authStatus, "conflict");
  assert.equal(index?.version, undefined);
});

test("different native implementations stay in conflict, not silently available", () => {
  const base = {
    name: "review", provider: "cursor" as const, endpointId: "mac",
    configuredEnabled: true, allowed: true, sessionIds: [],
  };
  const result = mergeConfiguredMcpServers(
    [{ ...base, version: "1" }],
    [{ ...base, version: "2", sessionIds: ["chat"] }],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.authStatus, "conflict");
  assert.equal(result[0]?.version, undefined);
  assert.deepEqual(result[0]?.sessionIds, ["chat"]);
});

test("a prior conflict cannot be cleared by one later execution report", () => {
  const base = {
    name: "review", provider: "cursor" as const, endpointId: "mac",
    configuredEnabled: true, allowed: true,
  };
  const result = mergeConfiguredMcpServers(
    [{ ...base, authStatus: "conflict", sessionIds: [], version: undefined }],
    [{ ...base, authStatus: "ready", sessionIds: ["chat-a"], version: "2" }],
  );
  assert.equal(result[0]?.authStatus, "conflict");
  assert.equal(result[0]?.version, undefined);
  assert.deepEqual(result[0]?.sessionIds, ["chat-a"]);
});
