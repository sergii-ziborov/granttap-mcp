import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("published CLI starts the MCP server and exposes all GrantTap tools", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-mcp-"));
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["bin/granttap-mcp.mjs"],
    cwd: process.cwd(),
    env: { ...inheritedEnv, GRANTTAP_CONFIG_DIR: configDir },
    stderr: "pipe",
  });
  const client = new Client({ name: "granttap-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["ask", "ask_yes_no", "notify", "setup"],
  );

  const result = await client.callTool({ name: "notify", arguments: { message: "hello" } });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text");
  assert.equal(text?.type, "text");
  if (text?.text) assert.match(text.text, /not paired/i);
});
