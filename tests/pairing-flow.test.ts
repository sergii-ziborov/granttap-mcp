import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { machineConfigPath, phonePairingPath } from "../apps/bridge/src/config";
import { createOneTimePairing, reusablePairing } from "../apps/bridge/src/pairing";
import { createGrantTapServer, resetRelay } from "../apps/mcp/src/create-server";
import { connectInMemory, textResult } from "./support/mcp-client";

async function pairingRelay(status = 201): Promise<{
  url: string; body: () => string; close: () => Promise<void>;
}> {
  let body = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      body = Buffer.concat(chunks).toString("utf8");
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    body: () => body,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("one-time pairing persists only after relay acceptance and can be reused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-pairing-flow-"));
  const relay = await pairingRelay();
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => {
    delete process.env.GRANTTAP_CONFIG_DIR;
    await relay.close();
  });
  const pairing = await createOneTimePairing(relay.url, { installHooks: false });
  assert.equal(pairing.cursor, null);
  assert.equal(pairing.claude, null);
  assert.equal(pairing.codex, null);
  assert.equal(pairing.monitor, null);
  assert.match(pairing.manualToken, /^[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.match(pairing.qrPayload, /^granttap:\/\/pair-v2\?/);
  assert.doesNotThrow(() => JSON.parse(relay.body()));
  assert.equal(relay.body().includes(pairing.phoneCfg.mySecretKey), false);
  assert.equal(reusablePairing()?.room, pairing.machineCfg.room);
  assert.equal(reusablePairing(true), null);

  const originalPhone = await readFile(phonePairingPath(), "utf8");
  await writeFile(phonePairingPath(), JSON.stringify({ ...pairing.phoneCfg, room: "wrong-room" }));
  assert.equal(reusablePairing(), null);
  await writeFile(phonePairingPath(), originalPhone);
  await writeFile(machineConfigPath(), "not-json");
  assert.equal(reusablePairing(), null);
});

test("pairing failures do not persist a replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-pairing-failure-"));
  const rejected = await pairingRelay(503);
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => {
    delete process.env.GRANTTAP_CONFIG_DIR;
    await rejected.close();
  });
  await assert.rejects(
    createOneTimePairing(rejected.url, { installHooks: false }),
    /rejected pairing with HTTP 503/,
  );
  assert.equal(reusablePairing(), null);
  await assert.rejects(
    createOneTimePairing("ws://127.0.0.1:1", { installHooks: false }),
    /relay is unavailable/,
  );
});

test("connect MCP returns a one-time QR and then reuses the pairing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-connect-tool-"));
  const relay = await pairingRelay();
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_TEST_RELAY_URL = relay.url;
  resetRelay();
  t.after(async () => {
    resetRelay();
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_TEST_RELAY_URL;
    await relay.close();
  });
  const client = await connectInMemory(createGrantTapServer());
  t.after(() => client.close());
  const first = await client.callTool({ name: "connect", arguments: {} });
  assert.equal(first.isError, undefined);
  assert.match(textResult(first), /one-time link/i);
  assert.equal((first.content as Array<{ type: string }>).some((item) => item.type === "image"), true);
  const reused = await client.callTool({ name: "connect", arguments: {} });
  assert.equal(reused.isError, undefined);
  assert.match(textResult(reused), /existing secure pairing reused/i);
  assert.equal((reused.content as Array<{ type: string }>).some((item) => item.type === "image"), false);
});
