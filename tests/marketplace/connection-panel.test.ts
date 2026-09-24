import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGrantTapServer } from "../../apps/mcp/src/http/create-server";
import { connectInMemory } from "../support/mcp-client";

const root = join(import.meta.dirname, "../..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;

test("Codex, Claude Code, Grok Build, and Cursor ship the same connection panel contract", async () => {
  const codex = json("plugins/granttap/.codex-plugin/plugin.json");
  const shared = json("plugins/granttap/.mcp.json").mcpServers;
  const claude = json("plugins/granttap/.claude-plugin/plugin.json");
  const grok = json("plugins/granttap/.grok-plugin/plugin.json");
  const cursor = json("cursor-plugin/mcp.json") as { mcpServers: { granttap: { command: string; args: string[] } } };
  assert.deepEqual(codex.mcpServers, shared);
  assert.equal(claude.name, "granttap");
  assert.equal(grok.name, "granttap");
  assert.equal(cursor.mcpServers.granttap.command, "node");
  assert.equal(cursor.mcpServers.granttap.args[0], "-e");

  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-panel-hosts-"));
  const server = createGrantTapServer();
  const client = await connectInMemory(server);
  try {
    const tools = await client.listTools();
    const status = tools.tools.find((tool) => tool.name === "connection_status");
    const add = tools.tools.find((tool) => tool.name === "connect");
    const reconnect = tools.tools.find((tool) => tool.name === "reconnect");
    for (const tool of [status, add, reconnect]) {
      assert.equal((tool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri,
        "ui://granttap/connection/v2.html");
    }
    const result = await client.callTool({ name: "connection_status", arguments: {} });
    assert.equal((result.structuredContent as { status: string }).status, "disconnected");
    const resource = await client.readResource({ uri: "ui://granttap/connection/v2.html" });
    const panel = resource.contents[0] as { mimeType?: string; text?: string };
    assert.equal(panel.mimeType, "text/html;profile=mcp-app");
    assert.match(panel.text ?? "", /Add another device/);
    assert.match(panel.text ?? "", /Refresh status/);
  } finally {
    await client.close();
    await server.close();
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  }
});
