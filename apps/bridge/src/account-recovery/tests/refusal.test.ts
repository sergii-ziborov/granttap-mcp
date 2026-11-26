import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair, open } from "../../../../../packages/core/crypto";
import { StoreLockError } from "../../../../../packages/core/store-file-lock";
import { createPairing, machineConfigPath, saveConfig } from "../../config";
import { PhoneLimitReached } from "../../paired-phones";
import { createRecoveryOffer, PairingIncomplete } from "../offer";
import { refusalFor, sealRefusal } from "../refusal";

const machineId = "22222222-2222-4222-8222-222222222222";
const phone = generateKeyPair();
const request = { id: "66666666-6666-4666-8666-666666666666",
  phonePublicKey: Buffer.from(phone.publicKey, "base64").toString("base64url"), expiresAt: Date.now() + 120_000 };
const refusal = { schema: "granttap.account-refusal.v1", requestId: request.id, machineId } as const;

test("a phone is told the phone limit with the count, an incomplete pairing, or that the Mac cannot answer", () => {
  assert.deepEqual(refusalFor(request, machineId, new PhoneLimitReached(17)),
    { ...refusal, reason: "phone_limit", phones: 17 });
  assert.deepEqual(refusalFor(request, machineId, new PairingIncomplete()), { ...refusal, reason: "pairing_incomplete" });
  assert.deepEqual(refusalFor(request, machineId, new Error("EACCES")), { ...refusal, reason: "unavailable" });
});

test("a busy pairing lock and a request that cannot be answered get no refusal", () => {
  assert.equal(refusalFor(request, machineId, new StoreLockError("busy")), null, "a later poll offers again");
  assert.equal(refusalFor({ ...request, expiresAt: Date.now() - 1 }, machineId, new Error("expired")), null);
  assert.equal(refusalFor({ ...request, phonePublicKey: "short" }, machineId, new Error("bad key")), null);
  assert.equal(refusalFor(request, "not-a-machine", new Error("bad machine")), null);
});

test("a refusal is sealed as an offer is and only the asking phone opens it", () => {
  const sealed = sealRefusal({ ...refusal, reason: "phone_limit", phones: 17 }, request.phonePublicKey);
  assert.ok(Buffer.byteLength(sealed) < 8192);
  const envelope = JSON.parse(sealed) as { senderPublicKey: string; nonce: string; box: string };
  assert.deepEqual(Object.keys(envelope), ["senderPublicKey", "nonce", "box"]);
  assert.deepEqual(open(envelope.nonce, envelope.box, envelope.senderPublicKey, phone.secretKey),
    { ...refusal, reason: "phone_limit", phones: 17 });
  assert.equal(open(envelope.nonce, envelope.box, envelope.senderPublicKey, generateKeyPair().secretKey), null);
});

test("a pairing file without its phone half is refused as an incomplete pairing", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-recovery-refusal-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  saveConfig(machineConfigPath(), createPairing("wss://relay.granttap.com/ws").machineCfg);
  assert.throws(() => createRecoveryOffer(request, machineId), (error: unknown) => error instanceof PairingIncomplete
    && refusalFor(request, machineId, error)?.reason === "pairing_incomplete");
});
