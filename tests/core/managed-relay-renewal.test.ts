import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { generateKeyPair } from "../../packages/core/crypto";
import { RelayClient } from "../../packages/core/relay-client";

test("a long-lived computer renews managed admission without dropping its socket or chat keys", { timeout: 2_000 }, async t => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const own = generateKeyPair(), peer = generateKeyPair();
  let calls = 0, deadline = 0, connections = 0;
  const renewals: string[] = [];
  let renewed!: () => void;
  const renewal = new Promise<void>(resolve => { renewed = resolve; });
  sockets.on("connection", socket => {
    connections += 1;
    socket.on("message", raw => {
      const value = JSON.parse(raw.toString());
      if (value.type === "relay.admission") { renewals.push(value.ticket); renewed(); }
    });
  });
  const client = new RelayClient({ relayUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    room: "fixture-room", role: "machine", deviceName: "fixture", senderId: "fixture",
    myPublicKey: own.publicKey, mySecretKey: own.secretKey, peerPublicKey: peer.publicKey }, {
    upgradeHeaders: async () => { calls += 1; deadline = Date.now() + 200;
      return { "X-GrantTap-Admission": `fixture-ticket-${calls}` }; },
    connectionLeaseExpiresAt: () => deadline,
  });
  t.after(async () => { client.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve()))); });
  client.setSessionKey("task", "retained-fixture-key");
  await client.connect();
  await Promise.race([renewal, new Promise((_, reject) => setTimeout(() => reject(Error("No admission renewal")), 800))]);
  assert.deepEqual(renewals, ["fixture-ticket-2"]);
  assert.equal(connections, 1);
  assert.equal(client.isConnected, true);
  assert.equal(client.hasSessionKey("task"), true);
  client.close();
  const stoppedCalls = calls;
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(calls, stoppedCalls, "Closing a client must cancel authorization renewal");
});
