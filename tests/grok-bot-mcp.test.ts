import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveTestGrokBotEndpoint } from "./support/grok-bot-endpoint";

test("scoped Grok Bot MCP exposes Mesh operations and no administrative tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-mcp-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  saveTestGrokBotEndpoint({
    pairing: {
      relayUrl: "ws://127.0.0.1:1", room: "a".repeat(32), role: "machine",
      deviceName: "Grok Bot Cloud", senderId: "bot",
      myPublicKey: Buffer.alloc(32, 1).toString("base64"),
      mySecretKey: Buffer.alloc(32, 2).toString("base64"),
      peerPublicKey: Buffer.alloc(32, 3).toString("base64"), pushAuth: "b".repeat(64),
    },
    projectIds: ["project"], actorId: "qa", createdAt: Date.now(),
  });
  delete process.env.GRANTTAP_CONFIG_DIR;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["bin/granttap-mcp.mjs", "internal", "mesh-mcp"], cwd: process.cwd(),
    env: { ...process.env, GRANTTAP_CONFIG_DIR: root }, stderr: "pipe",
  });
  const client = new Client({ name: "grok-mesh-test", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "mesh_accept_handoff", "mesh_answer", "mesh_artifact_ready", "mesh_claim",
    "mesh_complete", "mesh_handoff", "mesh_progress", "mesh_question",
    "mesh_reject_handoff", "mesh_release", "mesh_status", "mesh_task",
  ]);
  assert.equal(tools.tools.some((tool) => /invite|endpoint|relay|provider|setup|hook/i.test(tool.name)), false);
  const result = await client.callTool({
    name: "mesh_status", arguments: { actorId: "qa", projectId: "project" },
  });
  assert.notEqual(result.isError, true);
});
