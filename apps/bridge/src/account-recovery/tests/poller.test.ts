import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair, open } from "../../../../../packages/core/crypto";
import { saveAccountLink } from "../link";
import { pollAccountRecoveryOnce } from "../poller";

test("linked Mac answers a phone recovery request with ciphertext only", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-recovery-poller-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  const link = { accountId: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222", machineToken: "A".repeat(43) };
  assert.equal(saveAccountLink(link), true);
  const ephemeral = generateKeyPair();
  const requestId = "33333333-3333-4333-8333-333333333333";
  let posted = "";
  let changed = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(init?.headers && (init.headers as Record<string, string>).authorization,
      `Bearer ${link.machineToken}`);
    const url = String(input);
    if (url.endsWith("/api/account/machine/requests")) return Response.json({ requests: [{
      id: requestId,
      phonePublicKey: Buffer.from(ephemeral.publicKey, "base64").toString("base64url"),
      expiresAt: Date.now() + 120_000,
    }] });
    assert.ok(url.endsWith(`/api/account/machine/requests/${requestId}/offer`));
    posted = String(init?.body);
    return Response.json({ ok: true });
  };
  await pollAccountRecoveryOnce("https://granttap.com", fakeFetch, () => { changed++; });
  assert.equal(changed, 1);
  assert.ok(posted);
  assert.equal(posted.includes("mySecretKey"), false);
  const envelope = JSON.parse((JSON.parse(posted) as { encryptedOffer: string }).encryptedOffer);
  const payload = open(envelope.nonce, envelope.box, envelope.senderPublicKey,
    ephemeral.secretKey) as { machineId: string; pairing: { role: string } };
  assert.equal(payload.machineId, link.machineId);
  assert.equal(payload.pairing.role, "phone");
});
