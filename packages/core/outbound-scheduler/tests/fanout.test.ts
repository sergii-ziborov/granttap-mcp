import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RelayClient } from "../../relay-client";
import { generateKeyPair } from "../../crypto";

test("an encrypted eight-controller catalog burst stays connected below the relay rate cap", async t => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let received = 0, maximum = 0;
  let complete!: () => void, fail!: (error: Error) => void;
  const delivered = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const expected = 8 * 71; // encrypted hello plus seventy replaceable catalog messages
  server.on("connection", socket => {
    let start = performance.now(), count = 0;
    socket.on("message", raw => {
      if (performance.now() - start >= 1_000) { start = performance.now(); count = 0; }
      maximum = Math.max(maximum, ++count);
      if (count > 300) { socket.close(1008, "rate limit"); fail(new Error("Fanout exceeded the relay cap")); return; }
      const envelope = JSON.parse(raw.toString());
      assert.equal(typeof envelope.box, "string");
      assert.equal(envelope.text, undefined, "Relay frames must still be ciphertext");
      if (++received === expected) complete();
    });
  });
  const machine = generateKeyPair(), peers = Array.from({ length: 8 }, () => generateKeyPair());
  const client = new RelayClient({ relayUrl: `ws://127.0.0.1:${address.port}`, room: "rate-test",
    role: "machine", deviceName: "fixture", senderId: "fixture", ...{
      myPublicKey: machine.publicKey, mySecretKey: machine.secretKey },
    peerPublicKey: peers[0]!.publicKey, extraPeerPublicKeys: peers.slice(1).map(x => x.publicKey) });
  t.after(async () => { client.close(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); });
  const timeout = setTimeout(() => fail(new Error("Catalog burst did not finish")), 10_000);
  t.after(() => clearTimeout(timeout));
  await client.connect();
  await Promise.all([delivered, Promise.all(Array.from({ length: 70 }, () => client.send({
    type: "agent.event", kind: "status", text: "fixture", createdAt: Date.now(),
  }, "phone", { reliable: false })))]);
  assert.equal(received, expected);
  assert.ok(maximum <= 300);
  assert.equal(client.isConnected, true);
});
