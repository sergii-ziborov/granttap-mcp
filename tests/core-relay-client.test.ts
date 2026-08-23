import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, generateTransferKey, seal, sealWithTransferKey } from "../packages/core/crypto";
import { RelayClient, type PeerConfig } from "../packages/core/relay-client";
import type { Envelope, Payload } from "../packages/protocol/schema";

function receiveRaw(client: RelayClient, envelope: Envelope): Promise<void> {
  return (client as unknown as { onRaw(raw: string): Promise<void> }).onRaw(JSON.stringify(envelope));
}

function encryptedEnvelope(
  payload: Payload,
  room: string,
  from: "machine" | "phone",
  to: "machine" | "phone" | "all",
  senderSecretKey: string,
  recipientPublicKey: string,
  deliveryId = "delivery-1",
): Envelope {
  const encrypted = seal(payload, recipientPublicKey, senderSecretKey);
  return {
    v: 1,
    room,
    from,
    to,
    senderId: `${from}-1`,
    deliveryId,
    nonce: encrypted.nonce,
    box: encrypted.box,
  };
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
  const valid = encryptedEnvelope(
    payload,
    phoneCfg.room,
    "machine",
    "phone",
    machine.secretKey,
    phone.publicKey,
  );

  await receiveRaw(client, { ...valid, from: "phone" });
  await receiveRaw(client, { ...valid, to: "machine" });
  assert.equal(received.length, 0);

  await receiveRaw(client, valid);
  await receiveRaw(client, { ...valid, deliveryId: "attacker-changed-id" });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "agent.event");
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
  const envelope = encryptedEnvelope(
    payload,
    cfg.room,
    "phone",
    "machine",
    phone.secretKey,
    machine.publicKey,
  );

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
  await receiveRaw(phoneClient, encryptedEnvelope(
    grant,
    phoneCfg.room,
    "machine",
    "phone",
    machine.secretKey,
    phone.publicKey,
    "grant",
  ));
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
  await receiveRaw(phoneClient, encryptedEnvelope(
    wrapper,
    phoneCfg.room,
    "machine",
    "phone",
    machine.secretKey,
    phone.publicKey,
    "sealed",
  ));

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
    await receiveRaw(phoneClient, encryptedEnvelope(
      {
        type: "session.sealed",
        sessionId: "task-a",
        nonce: sealed.nonce,
        box: sealed.box,
        createdAt: Date.now(),
      },
      phoneCfg.room,
      "machine",
      "phone",
      machine.secretKey,
      phone.publicKey,
      deliveryId,
    ));
  }
  assert.deepEqual(received.map((payload) => payload.type), ["session.key.grant"]);

  const matchingInner = sealWithTransferKey({
    type: "agent.event",
    sessionId: "task-a",
    text: "exact task",
    createdAt: Date.now(),
  } satisfies Payload, transferKey);
  await receiveRaw(phoneClient, encryptedEnvelope(
    {
      type: "session.sealed",
      sessionId: "task-a",
      nonce: matchingInner.nonce,
      box: matchingInner.box,
      createdAt: Date.now(),
    },
    phoneCfg.room,
    "machine",
    "phone",
    machine.secretKey,
    phone.publicKey,
    "sealed-matching",
  ));
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
  await receiveRaw(machineClient, encryptedEnvelope(
    grant,
    machineCfg.room,
    "phone",
    "machine",
    phone.secretKey,
    machine.publicKey,
    "forged-grant",
  ));
  assert.equal(machineClient.hasSessionKey("task-a"), false);

  const authorizedTaskGrant: Payload = {
    ...grant,
    purpose: "task",
  };
  await receiveRaw(machineClient, encryptedEnvelope(
    authorizedTaskGrant,
    machineCfg.room,
    "phone",
    "machine",
    phone.secretKey,
    machine.publicKey,
    "authorized-task-grant",
  ));
  assert.equal(machineClient.hasSessionKey("task-a"), true);
});
