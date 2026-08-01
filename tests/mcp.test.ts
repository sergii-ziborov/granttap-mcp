import assert from "node:assert/strict";
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
      GRANTTAP_RELAY_URL: relayUrl,
      GRANTTAP_SKIP_HOOKS: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "granttap-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["ask", "ask_yes_no", "connect", "notify", "setup"],
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
  }>;
  const pairingText = pairingContent.find((item) => item.type === "text")?.text ?? "";
  const pairingImage = pairingContent.find((item) => item.type === "image");
  assert.match(pairingText, /one-time code:/i);
  assert.match(pairingText, /single-use/i);
  assert.equal(pairingImage?.mimeType, "image/png");
  assert.deepEqual(
    Buffer.from(pairingImage?.data ?? "", "base64").subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.match(parkedPath, /^\/pair\/[A-Z2-9]{8}$/);
  assert.doesNotThrow(() => JSON.parse(parkedBody));

  const phoneConfig = await readFile(join(configDir, "phone.pairing.json"), "utf8");
  const phoneSecret = JSON.parse(phoneConfig).mySecretKey as string;
  assert.ok(phoneSecret);
  assert.equal(pairingText.includes(phoneSecret), false);
  assert.equal(Buffer.from(pairingImage?.data ?? "", "base64").includes(Buffer.from(phoneSecret)), false);
});
