import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { generateKeyPair } from "../../../../../../packages/core/crypto";
import { RelayClient } from "../../../../../../packages/core/relay-client";
import { saveConfig, machineConfigPath } from "../../../../../bridge/src/config";
import { saveAccountLink } from "../../../../../bridge/src/account-recovery/link";
import { relay, resetRelay } from "../relay";

test("MCP connection obtains managed admission before its real socket upgrade", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-mcp-managed-access-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { delete process.env.GRANTTAP_CONFIG_DIR; resetRelay(); });
  const machine = generateKeyPair(), phone = generateKeyPair();
  const config = { relayUrl: "wss://relay.granttap.com", room: "managed-mcp-fixture",
    role: "machine" as const, deviceName: "fixture", senderId: "fixture",
    myPublicKey: machine.publicKey, mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey };
  saveConfig(machineConfigPath(), config);
  saveAccountLink({ accountId: "12345678-1234-4123-8123-123456789012",
    machineId: "22345678-1234-4123-8123-123456789012", machineToken: "A".repeat(43) });
  let authorizationRequests = 0, acceptedUpgrades = 0;
  t.mock.method(globalThis, "fetch", async (address: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(address), "https://granttap.com/api/account/machine/admission");
    assert.equal((options?.headers as Record<string, string>).authorization, `Bearer ${"A".repeat(43)}`);
    assert.deepEqual(JSON.parse(options!.body as string), { room: config.room, publicKey: config.myPublicKey });
    authorizationRequests++;
    return Response.json({ ticket: "managed-fixture-ticket", expiresAt: Date.now() + 300_000 });
  });
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers["x-granttap-admission"] !== "managed-fixture-ticket") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    acceptedUpgrades++;
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws, request));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    resetRelay();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    sockets.close();
  });
  const port = (server.address() as { port: number }).port;
  const connect = RelayClient.prototype.connect;
  t.mock.method(RelayClient.prototype, "connect", function (this: RelayClient) {
    // Route only the test socket to the real local server; keep the account
    // authorization code and lease behavior used by the public MCP entry point.
    const internal = this as unknown as { cfg: { relayUrl: string } };
    internal.cfg.relayUrl = `ws://127.0.0.1:${port}`;
    return connect.call(this);
  });
  const client = await relay();
  assert.ok(client?.isConnected, "the MCP socket must satisfy commercial relay authorization");
  assert.equal(authorizationRequests, 1);
  assert.equal(acceptedUpgrades, 1);
});
