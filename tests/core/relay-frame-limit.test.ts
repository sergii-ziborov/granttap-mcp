import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair } from "../../packages/core/crypto";
import { MAX_STORED_FRAME_BYTES, sealEnvelope } from "../../packages/core/relay-envelope";
import type { PeerConfig } from "../../packages/core/relay-client-types";

const machine = generateKeyPair();
const phone = generateKeyPair();
const cfg: PeerConfig = { relayUrl: "ws://127.0.0.1:1", room: "room-a", role: "machine", deviceName: "mac",
  senderId: "mac-1", myPublicKey: machine.publicKey, mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey };
const huge = { type: "notify", message: "x".repeat(MAX_STORED_FRAME_BYTES), createdAt: 1 } as any;

test("a frame the relay would refuse to store is refused here, so the relay never closes the computer's socket", () => {
  assert.throws(() => sealEnvelope(cfg, huge, "phone"), /stored-message limit/);
  assert.throws(() => sealEnvelope(cfg, huge, "phone", { reliable: true }), /stored-message limit/);
  assert.doesNotThrow(() => sealEnvelope(cfg, huge, "phone", { reliable: false }),
    "A frame the relay forwards without storing is bounded only by the socket.");
  assert.doesNotThrow(() => sealEnvelope(cfg, huge, "all"));
  const small = JSON.parse(sealEnvelope(cfg, { type: "notify", message: "hi", createdAt: 1 } as any, "phone"));
  assert.equal(typeof small.deliveryId, "string");
});
