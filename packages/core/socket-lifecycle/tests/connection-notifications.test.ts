import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { generateKeyPair } from "../../crypto";
import { RelayClient } from "../../relay-client";

test("socket recovery notifies active consumers once and isolates failed consumers", async t => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const keys = generateKeyPair(), peer = generateKeyPair();
  const client = new RelayClient({ relayUrl: `ws://127.0.0.1:${address.port}`, room: "recovery-test",
    role: "machine", deviceName: "test computer", senderId: "recovery-test",
    myPublicKey: keys.publicKey, mySecretKey: keys.secretKey, peerPublicKey: peer.publicKey },
  { autoReconnect: true, minReconnectMs: 10, maxReconnectMs: 40 });
  t.after(async () => {
    client.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  client.onConnected(() => { throw Error("isolated synchronous failure"); });
  client.onConnected(async () => { throw Error("isolated asynchronous failure"); });
  let opens = 0, removedCalls = 0;
  const off = client.onConnected(() => { removedCalls++; });
  off();
  let recovered!: () => void;
  const recovery = new Promise<void>(resolve => { recovered = resolve; });
  client.onConnected(() => { if (++opens === 2) recovered(); });
  await client.connect();
  await client.connect();
  assert.equal(opens, 1, "Reusing an open socket does not announce another connection");
  const socket = [...wss.clients][0]!;
  const closed = once(socket, "close");
  socket.close(1001, "test recovery");
  await closed;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([recovery, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error("Socket recovery was not announced")), 2_000);
    })]);
  } finally { clearTimeout(timeout); }
  assert.equal(opens, 2);
  assert.equal(removedCalls, 0);
  assert.equal(client.isConnected, true);
});
