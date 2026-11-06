import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { generateKeyPair } from "../../crypto";
import { RelayClient } from "../../relay-client";

test("a slow pong uses its configured deadline instead of the next ping interval", { timeout: 2_000 }, async t => {
  const server = new WebSocketServer({ port: 0, autoPong: false });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const own = generateKeyPair(), peer = generateKeyPair();
  const client = new RelayClient({ relayUrl: `ws://127.0.0.1:${address.port}`, room: "health-fixture",
    role: "machine", deviceName: "fixture", senderId: "fixture", myPublicKey: own.publicKey,
    mySecretKey: own.secretKey, peerPublicKey: peer.publicKey },
  { pingIntervalMs: 15, pongTimeoutMs: 250 });
  t.after(async () => {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const connected = once(server, "connection");
  await client.connect();
  const [socket] = await connected;
  await once(socket, "ping");
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(client.isConnected, true, "A pending ping is not a missed pong deadline");
  const pong = once(socket, "pong");
  socket.pong();
  // Keep the test server observable without relying on private client fields.
  socket.ping();
  await pong;
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(client.isConnected, true, "An answered ping must preserve the same transport");
  await once(socket, "close");
  assert.equal(client.isConnected, false, "A silent peer is eventually disconnected");
});
