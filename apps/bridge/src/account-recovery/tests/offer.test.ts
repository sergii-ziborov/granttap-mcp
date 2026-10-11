import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair, open, seal } from "../../../../../packages/core/crypto";
import { createPairing, loadConfig, machineConfigPath, phonePairingPath, saveConfig } from "../../config";
import { createRecoveryOffer } from "../offer";

test("passkey recovery seals a usable phone half and authorizes its key locally", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-recovery-offer-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  const ephemeral = generateKeyPair();
  const requestId = "11111111-1111-4111-8111-111111111111";
  const machineId = "22222222-2222-4222-8222-222222222222";
  const offer = createRecoveryOffer({ id: requestId,
    phonePublicKey: Buffer.from(ephemeral.publicKey, "base64").toString("base64url"),
    expiresAt: Date.now() + 120_000 }, machineId);
  const sealed = JSON.parse(offer) as { senderPublicKey: string; nonce: string; box: string };
  const payload = open(sealed.nonce, sealed.box, sealed.senderPublicKey, ephemeral.secretKey) as {
    schema: string; requestId: string; machineId: string;
    pairing: { myPublicKey: string; peerPublicKey: string; room: string };
  };
  assert.equal(payload.schema, "granttap.account-offer.v1");
  assert.equal(payload.requestId, requestId);
  assert.equal(payload.machineId, machineId);
  assert.equal(payload.pairing.peerPublicKey, loadConfig(machineConfigPath()).myPublicKey);
  assert.equal(payload.pairing.myPublicKey, loadConfig(machineConfigPath()).peerPublicKey);
  assert.equal(payload.pairing.room, loadConfig(machineConfigPath()).room);
  const second = generateKeyPair();
  const another = JSON.parse(createRecoveryOffer({
    id: "33333333-3333-4333-8333-333333333333",
    phonePublicKey: Buffer.from(second.publicKey, "base64").toString("base64url"),
    expiresAt: Date.now() + 120_000,
  }, machineId)) as { senderPublicKey: string; nonce: string; box: string };
  const next = open(another.nonce, another.box, another.senderPublicKey,
    second.secretKey) as typeof payload;
  const machine = loadConfig(machineConfigPath());
  assert.equal(next.pairing.room, payload.pairing.room);
  assert.equal(machine.peerPublicKey, payload.pairing.myPublicKey);
  assert.ok(machine.extraPeerPublicKeys?.includes(next.pairing.myPublicKey));
});

test("account recovery uses the current machine key when its parked QR half is stale", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-recovery-stale-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  const { machineCfg, phoneCfg } = createPairing("wss://relay.granttap.com/ws");
  const staleMachineKey = generateKeyPair();
  saveConfig(machineConfigPath(), machineCfg);
  saveConfig(phonePairingPath(), { ...phoneCfg, peerPublicKey: staleMachineKey.publicKey });
  const recipient = generateKeyPair();
  const offer = JSON.parse(createRecoveryOffer({
    id: "33333333-3333-4333-8333-333333333333",
    phonePublicKey: Buffer.from(recipient.publicKey, "base64").toString("base64url"),
    expiresAt: Date.now() + 120_000,
  }, "22222222-2222-4222-8222-222222222222"));
  const payload = open(offer.nonce, offer.box, offer.senderPublicKey, recipient.secretKey) as {
    pairing: { peerPublicKey: string; myPublicKey: string; mySecretKey: string; room: string };
  };
  assert.equal(payload.pairing.peerPublicKey === machineCfg.myPublicKey, true,
    "a recovered phone must encrypt to the actual machine, not a parked QR key");
  const durable = loadConfig(machineConfigPath());
  assert.equal(durable.mySecretKey, machineCfg.mySecretKey);
  assert.equal(durable.peerPublicKey, machineCfg.peerPublicKey);
  assert.equal(payload.pairing.room, machineCfg.room);
  assert.ok(durable.extraPeerPublicKeys?.includes(payload.pairing.myPublicKey));
  const message = seal({ type: "probe" }, durable.myPublicKey, payload.pairing.mySecretKey);
  assert.deepEqual(open(message.nonce, message.box, payload.pairing.myPublicKey, durable.mySecretKey),
    { type: "probe" });
});
