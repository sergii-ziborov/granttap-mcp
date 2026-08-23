import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("published CLI starts the MCP server and exposes all GrantTap tools", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-mcp-"));
  let parkedPath = "";
  let parkedBody = "";
  let pairingWrites = 0;
  const relayServer = createServer((request, response) => {
    if (request.method !== "PUT" || !request.url?.startsWith("/pair/")) {
      response.statusCode = 404;
      response.end();
      return;
    }
    parkedPath = request.url;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      pairingWrites += 1;
      parkedBody = Buffer.concat(chunks).toString("utf8");
      response.statusCode = 201;
      response.end();
    });
  });
  await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    relayServer.close((error) => error ? reject(error) : resolve());
  }));
  const address = relayServer.address();
  assert(address && typeof address === "object");
  const relayUrl = `ws://127.0.0.1:${address.port}`;
  const cursorDir = join(configDir, "cursor");
  const claudeDir = join(configDir, "claude");
  const codexDir = join(configDir, "codex");
  const agentsDir = join(configDir, "LaunchAgents");

  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["bin/granttap-mcp.mjs"],
    cwd: process.cwd(),
    env: {
      ...inheritedEnv,
      GRANTTAP_CONFIG_DIR: configDir,
      GRANTTAP_TEST_RELAY_URL: relayUrl,
      GRANTTAP_CURSOR_DIR: cursorDir,
      GRANTTAP_CLAUDE_DIR: claudeDir,
      GRANTTAP_CODEX_DIR: codexDir,
      GRANTTAP_LAUNCH_AGENTS_DIR: agentsDir,
      GRANTTAP_PINNED_MONITOR_BIN: join(configDir, "missing-nodvox-monitor"),
      GRANTTAP_PINNED_MONITOR_ROOT: join(configDir, "missing-nodvox-root"),
      GRANTTAP_SKIP_LAUNCHCTL: "1",
      GRANTTAP_NODE: process.execPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "granttap-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "ask", "ask_yes_no", "connect", "notify",
  ]);
  for (const tool of tools.tools) {
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, false);
    if (tool.name !== "connect") assert.equal(tool.annotations?.idempotentHint, false);
  }
  const connectTool = tools.tools.find((tool) => tool.name === "connect");
  assert.deepEqual(Object.keys(connectTool?.inputSchema.properties ?? {}), []);
  const notifyTool = tools.tools.find((tool) => tool.name === "notify");
  assert.equal(
    (notifyTool?.inputSchema.properties?.message as { maxLength?: number })?.maxLength,
    2_000,
  );

  const result = await client.callTool({ name: "notify", arguments: { message: "hello" } });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text");
  assert.equal(text?.type, "text");
  if (text?.text) assert.match(text.text, /not paired/i);

  const pairingResult = await client.callTool({ name: "connect", arguments: {} });
  assert.notEqual(pairingResult.isError, true);
  const pairingContent = pairingResult.content as Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    annotations?: { audience?: string[] };
  }>;
  const pairingText = pairingContent.find((item) => item.type === "text")?.text ?? "";
  const pairingImage = pairingContent.find((item) => item.type === "image");
  assert.doesNotMatch(pairingText, /manual secure token:/i);
  assert.match(pairingText, /one-time/i);
  assert.equal(pairingImage?.mimeType, "image/png");
  assert.deepEqual(pairingImage?.annotations?.audience, ["user"]);
  assert.deepEqual(
    Buffer.from(pairingImage?.data ?? "", "base64").subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.match(parkedPath, /^\/pair\/[a-f0-9]{32}$/);
  assert.doesNotThrow(() => JSON.parse(parkedBody));

  const phoneConfig = await readFile(join(configDir, "phone.pairing.json"), "utf8");
  const machineConfig = await readFile(join(configDir, "machine.json"), "utf8");
  const phoneSecret = JSON.parse(phoneConfig).mySecretKey as string;
  assert.ok(phoneSecret);
  assert.equal(pairingText.includes(phoneSecret), false);
  assert.equal(Buffer.from(pairingImage?.data ?? "", "base64").includes(Buffer.from(phoneSecret)), false);
  const mailboxId = parkedPath.split("/").at(-1)!;
  // Pair-v2 intentionally carries the public one-time mailbox id in its URI;
  // the independent transfer key, never the mailbox id, protects the payload.
  assert.equal(pairingText.includes(mailboxId), true);
  assert.equal(parkedBody.includes(mailboxId), false);

  const reusedResult = await client.callTool({ name: "connect", arguments: {} });
  const reusedContent = reusedResult.content as Array<{ type: string; text?: string }>;
  const reusedText = reusedContent.find((item) => item.type === "text")?.text ?? "";
  assert.match(reusedText, /existing secure pairing reused/i);
  assert.doesNotMatch(reusedText, /granttap:\/\/pair-v2|one-time/i);
  assert.equal(reusedContent.some((item) => item.type === "image"), false);
  assert.equal(pairingWrites, 1);
  assert.equal(await readFile(join(configDir, "machine.json"), "utf8"), machineConfig);
  assert.equal(await readFile(join(configDir, "phone.pairing.json"), "utf8"), phoneConfig);

  const cursorHooks = JSON.parse(await readFile(join(cursorDir, "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ command: string; failClosed?: boolean }>>;
  };
  assert.match(cursorHooks.hooks.beforeShellExecution?.[0]?.command ?? "", /internal hook cursor$/);
  assert.match(cursorHooks.hooks.afterShellExecution?.[0]?.command ?? "", /internal hook cursor-after$/);
  assert.match(cursorHooks.hooks.beforeMCPExecution?.[0]?.command ?? "", /internal hook cursor-mcp$/);
  assert.equal(cursorHooks.hooks.beforeMCPExecution?.[0]?.failClosed, false);
  assert.match(await readFile(join(claudeDir, "settings.json"), "utf8"), /Skill\|mcp__\.\*\|skill__\.\*/);
  assert.match(await readFile(join(codexDir, "config.toml"), "utf8"), /hook codex-policy/);
  assert.equal(existsSync(join(configDir, "mcp-oauth.json")), false);
  assert.equal(existsSync(join(cursorDir, "mcp.json")), false);
});
