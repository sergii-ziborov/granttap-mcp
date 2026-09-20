import { encryptedEnvelope } from "../support/transport/encrypted-envelope";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { generateKeyPair, generateTransferKey, sealWithTransferKey } from "../../packages/core/crypto";
import { RelayClient, type PeerConfig } from "../../packages/core/relay-client";
import type { Envelope, Payload } from "../../packages/protocol/schema";

function receiveRaw(client: RelayClient, envelope: Envelope): Promise<void> {
  return (client as unknown as { onRaw(raw: string): Promise<void> }).onRaw(JSON.stringify(envelope));
}

test("relay client rejects spoofed routing and authenticated ciphertext replays", async () => {
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const phoneCfg: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1",
    room: "room-a",
    role: "phone",
    deviceName: "phone",
    senderId: "phone-1",
    myPublicKey: phone.publicKey,
    mySecretKey: phone.secretKey,
    peerPublicKey: machine.publicKey,
  };
  const client = new RelayClient(phoneCfg);
  const received: Payload[] = [];
  client.onMessage((payload) => { received.push(payload); return true; });
  const payload: Payload = {
    type: "agent.event",
    text: "authenticated",
    createdAt: Date.now(),
  };
  const valid = encryptedEnvelope({ payload: payload, room: phoneCfg.room, from: "machine", to: "phone", senderSecretKey: machine.secretKey, recipientPublicKey: phone.publicKey });

  await receiveRaw(client, { ...valid, from: "phone" });
  await receiveRaw(client, { ...valid, to: "machine" });
  assert.equal(received.length, 0);

  await receiveRaw(client, valid);
  await receiveRaw(client, { ...valid, deliveryId: "attacker-changed-id" });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "agent.event");
});

test("a restart still refuses a ciphertext that was already accepted", async () => {
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const phoneCfg: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1",
    room: "room-persist",
    role: "phone",
    deviceName: "phone",
    senderId: "phone-1",
    myPublicKey: phone.publicKey,
    mySecretKey: phone.secretKey,
    peerPublicKey: machine.publicKey,
  };
  const replayPath = join(mkdtempSync(join(tmpdir(), "granttap-replay-")), "seen.json");
  const first = new RelayClient(phoneCfg, { replayPath });
  const seen: Payload[] = [];
  first.onMessage((payload) => { seen.push(payload); return true; });
  const envelope = encryptedEnvelope({ payload: { type: "agent.event", text: "once", createdAt: Date.now() }, room: phoneCfg.room, from: "machine", to: "phone", senderSecretKey: machine.secretKey, recipientPublicKey: phone.publicKey });
  await receiveRaw(first, envelope);
  const restarted = new RelayClient(phoneCfg, { replayPath });
  restarted.onMessage((payload) => { seen.push(payload); return true; });
  await receiveRaw(restarted, { ...envelope, deliveryId: "other-delivery" });
  assert.equal(seen.length, 1);
});

test("a phone in a shared room opens a second computer's envelopes", async () => {
  const first = generateKeyPair();
  const second = generateKeyPair();
  const phone = generateKeyPair();
  const client = new RelayClient({
    relayUrl: "ws://127.0.0.1:1",
    room: "room-shared",
    role: "phone",
    deviceName: "phone",
    senderId: "phone-1",
    myPublicKey: phone.publicKey,
    mySecretKey: phone.secretKey,
    peerPublicKey: first.publicKey,
    extraPeerPublicKeys: [second.publicKey],
  });
  const received: Payload[] = [];
  client.onMessage((payload) => { received.push(payload); return true; });
  const payload: Payload = {
    type: "machine.heartbeat",
    machine: "Second PC",
    createdAt: Date.now(),
  };
  await receiveRaw(client, encryptedEnvelope({ payload: payload, room: "room-shared", from: "machine", to: "phone", senderSecretKey: second.secretKey, recipientPublicKey: phone.publicKey, deliveryId: "delivery-second" }));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "machine.heartbeat");
});

test("relay ACK waits until one consumer actually accepts the decrypted payload", async () => {
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const cfg: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1",
    room: "room-ack",
    role: "machine",
    deviceName: "machine",
    senderId: "machine-1",
    myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey,
  };
  const client = new RelayClient(cfg);
  const acknowledgements: string[] = [];
  (client as unknown as { ws: { readyState: number; send(raw: string): void } }).ws = {
    readyState: 1,
    send: (raw) => acknowledgements.push(raw),
  };
  const payload: Payload = {
    type: "approval.decision",
    requestId: "approval-1",
    decision: "allow",
    decidedAt: Date.now(),
  };
  const envelope = encryptedEnvelope({ payload: payload, room: cfg.room, from: "phone", to: "machine", senderSecretKey: phone.secretKey, recipientPublicKey: machine.publicKey });

  await receiveRaw(client, envelope);
  assert.equal(acknowledgements.length, 0);

  let accepted = 0;
  client.onMessage(() => { accepted += 1; return true; });
  await receiveRaw(client, { ...envelope, deliveryId: "retry-id" });
  assert.equal(accepted, 1);
  assert.deepEqual(JSON.parse(acknowledgements[0]!), {
    type: "relay.ack",
    deliveryId: "retry-id",
  });
});

test("per-task sealed traffic is bound to its outer task and only machine grants keys", async () => {
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const transferKey = generateTransferKey();
  const phoneCfg: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1",
    room: "room-b",
    role: "phone",
    deviceName: "phone",
    senderId: "phone-1",
    myPublicKey: phone.publicKey,
    mySecretKey: phone.secretKey,
    peerPublicKey: machine.publicKey,
  };
  const phoneClient = new RelayClient(phoneCfg);
  const received: Payload[] = [];
  phoneClient.onMessage((payload) => { received.push(payload); return true; });

  const grant: Payload = {
    type: "session.key.grant",
    sessionId: "task-a",
    key: transferKey,
    createdAt: Date.now(),
  };
  await receiveRaw(phoneClient, encryptedEnvelope({ payload: grant, room: phoneCfg.room, from: "machine", to: "phone", senderSecretKey: machine.secretKey, recipientPublicKey: phone.publicKey, deliveryId: "grant" }));
  assert.equal(phoneClient.hasSessionKey("task-a"), true);

  const mismatchedInner = sealWithTransferKey({
    type: "agent.event",
    sessionId: "task-b",
    text: "must not cross tasks",
    createdAt: Date.now(),
  } satisfies Payload, transferKey);
  const wrapper: Payload = {
    type: "session.sealed",
    sessionId: "task-a",
    nonce: mismatchedInner.nonce,
    box: mismatchedInner.box,
    createdAt: Date.now(),
  };
  await receiveRaw(phoneClient, encryptedEnvelope({ payload: wrapper, room: phoneCfg.room, from: "machine", to: "phone", senderSecretKey: machine.secretKey, recipientPublicKey: phone.publicKey, deliveryId: "sealed" }));

  for (const [deliveryId, inner] of [
    ["sealed-missing", {
      type: "agent.event",
      text: "missing inner scope",
      createdAt: Date.now(),
    }],
    ["sealed-null", {
      type: "agent.event",
      sessionId: null,
      text: "null inner scope",
      createdAt: Date.now(),
    }],
  ] as const) {
    const sealed = sealWithTransferKey(inner, transferKey);
    await receiveRaw(phoneClient, encryptedEnvelope({ payload: {
        type: "session.sealed",
        sessionId: "task-a",
        nonce: sealed.nonce,
        box: sealed.box,
        createdAt: Date.now(),
      }, room: phoneCfg.room, from: "machine", to: "phone", senderSecretKey: machine.secretKey, recipientPublicKey: phone.publicKey, deliveryId: deliveryId }));
  }
  assert.deepEqual(received.map((payload) => payload.type), ["session.key.grant"]);

  const matchingInner = sealWithTransferKey({
    type: "agent.event",
    sessionId: "task-a",
    text: "exact task",
    createdAt: Date.now(),
  } satisfies Payload, transferKey);
  await receiveRaw(phoneClient, encryptedEnvelope({ payload: {
      type: "session.sealed",
      sessionId: "task-a",
      nonce: matchingInner.nonce,
      box: matchingInner.box,
      createdAt: Date.now(),
    }, room: phoneCfg.room, from: "machine", to: "phone", senderSecretKey: machine.secretKey, recipientPublicKey: phone.publicKey, deliveryId: "sealed-matching" }));
  assert.deepEqual(received.map((payload) => payload.type), [
    "session.key.grant",
    "agent.event",
  ]);

  const machineCfg: PeerConfig = {
    ...phoneCfg,
    role: "machine",
    deviceName: "machine",
    senderId: "machine-1",
    myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey,
  };
  const machineClient = new RelayClient(machineCfg);
  await receiveRaw(machineClient, encryptedEnvelope({ payload: grant, room: machineCfg.room, from: "phone", to: "machine", senderSecretKey: phone.secretKey, recipientPublicKey: machine.publicKey, deliveryId: "forged-grant" }));
  assert.equal(machineClient.hasSessionKey("task-a"), false);

  const authorizedTaskGrant: Payload = {
    ...grant,
    purpose: "task",
  };
  await receiveRaw(machineClient, encryptedEnvelope({ payload: authorizedTaskGrant, room: machineCfg.room, from: "phone", to: "machine", senderSecretKey: phone.secretKey, recipientPublicKey: machine.publicKey, deliveryId: "authorized-task-grant" }));
  assert.equal(machineClient.hasSessionKey("task-a"), true);
});

test("a relay that stops answering is treated as gone, not as connected", async () => {
  // A machine that changes network leaves its socket half-open: no close
  // arrives, `readyState` stays OPEN, and the computer keeps reporting itself
  // online while everything it sends goes nowhere.
  const http = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({ server: http, autoPong: false });
  let accepted = 0;
  wss.on("connection", () => { accepted += 1; });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");

  const keys = generateKeyPair();
  const peer = generateKeyPair();
  const client = new RelayClient({
    relayUrl: `ws://127.0.0.1:${(address as { port: number }).port}`,
    room: "room-liveness", role: "machine", deviceName: "mac", senderId: "machine-1",
    myPublicKey: keys.publicKey, mySecretKey: keys.secretKey, peerPublicKey: peer.publicKey,
  }, { autoReconnect: false, pingIntervalMs: 40 });

  await client.connect();
  assert.equal(client.isConnected, true);

  // Two ping periods: the first goes unanswered, the second gives up.
  const deadline = Date.now() + 5_000;
  while (client.isConnected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(client.isConnected, false, "an unanswered ping ends the connection");
  assert.equal(accepted, 1);

  client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
});
