import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { generateKeyPair, open } from "../../../../../packages/core/crypto";
import { live, pairedComputer } from "../../paired-phones/tests/support";
import { saveAccountLink } from "../link";
import { pollAccountRecoveryOnce } from "../poller";
import { accountLinkStatus } from "../../account-link-state";

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

const machineId = "22222222-2222-4222-8222-222222222222";

/** A linked Mac in a private config directory, the phone asking it, and the lines it writes to the log. */
async function linkedMac(t: TestContext, requestId: string) {
  const root = await mkdtemp(join(tmpdir(), "granttap-recovery-answer-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  saveAccountLink({ accountId: "11111111-1111-4111-8111-111111111111", machineId, machineToken: "A".repeat(43) });
  const phone = generateKeyPair();
  const item = { id: requestId, phonePublicKey: Buffer.from(phone.publicKey, "base64").toString("base64url"),
    expiresAt: Date.now() + 120_000 };
  const log: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => { log.push(String(chunk)); return true; });
  return { phone, item, log };
}

test("a Mac at the phone limit tells the phone why once, sealed to its key, and logs it once", async t => {
  const requestId = "44444444-4444-4444-8444-444444444444";
  const { phone, item, log } = await linkedMac(t, requestId);
  pairedComputer(16, [400, ...Array<number>(16).fill(0)], { now: Date.now() });
  const before = live();
  const posted: string[] = [];
  let changed = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/account/machine/requests")) return Response.json({ requests: [item] });
    assert.ok(String(input).endsWith(`/api/account/machine/requests/${requestId}/offer`));
    posted.push(String(init?.body));
    return Response.json({ ok: true });
  };
  for (let poll = 0; poll < 3; poll++) await pollAccountRecoveryOnce("https://granttap.com", fakeFetch, () => { changed++; });
  assert.equal(posted.length, 1, "the refusal is sent once, though the request stays listed");
  assert.equal(changed, 0);
  assert.deepEqual(live(), before, "a refused phone changes nothing");
  const encrypted = (JSON.parse(posted[0]!) as { encryptedOffer: string }).encryptedOffer;
  assert.ok(Buffer.byteLength(encrypted) < 8192);
  const envelope = JSON.parse(encrypted) as { senderPublicKey: string; nonce: string; box: string };
  assert.deepEqual(Object.keys(envelope).sort(), ["box", "nonce", "senderPublicKey"]);
  assert.deepEqual(open(envelope.nonce, envelope.box, envelope.senderPublicKey, phone.secretKey), {
    schema: "granttap.account-refusal.v1", requestId, machineId, reason: "phone_limit", phones: 17,
  });
  assert.equal(open(envelope.nonce, envelope.box, envelope.senderPublicKey, generateKeyPair().secretKey), null);
  assert.deepEqual(log, ["[account] could not answer a phone's account sign-in: This computer already has 17 "
    + "phones, and each was used in the last day. Remove one in GrantTap → Devices → this computer → Phones, then "
    + "add the new phone. (telling the phone: phone_limit)\n"]);
});

test("a network failure retries the same sealed offer, logs once and never refuses", async t => {
  const requestId = "55555555-5555-4555-8555-555555555555";
  const { phone, item, log } = await linkedMac(t, requestId);
  const posted: string[] = [];
  let changed = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/account/machine/requests")) return Response.json({ requests: [item] });
    posted.push(String(init?.body));
    if (posted.length === 1) throw new TypeError("fetch failed");
    return posted.length === 2 ? new Response("busy", { status: 503 }) : Response.json({ ok: true });
  };
  for (let poll = 0; poll < 3; poll++) await pollAccountRecoveryOnce("https://granttap.com", fakeFetch, () => { changed++; });
  assert.equal(posted.length, 3);
  assert.equal(new Set(posted).size, 1, "every attempt carries the one sealed offer");
  assert.equal(changed, 1);
  const envelope = JSON.parse((JSON.parse(posted[0]!) as { encryptedOffer: string }).encryptedOffer);
  const payload = open(envelope.nonce, envelope.box, envelope.senderPublicKey, phone.secretKey) as { schema: string };
  assert.equal(payload.schema, "granttap.account-offer.v1");
  assert.deepEqual(log, ["[account] could not answer a phone's account sign-in: fetch failed\n"]);
});

test("the poll's answer is this computer's account-link state: 200 confirms it, 401 is a revoked sign-in", async t => {
  const { log } = await linkedMac(t, "66666666-6666-4666-8666-666666666666");
  await pollAccountRecoveryOnce("https://granttap.com", async () => Response.json({ requests: [] }));
  assert.equal(accountLinkStatus().state, "ok");
  assert.equal(typeof accountLinkStatus().checkedAt, "number");
  await assert.rejects(pollAccountRecoveryOnce("https://granttap.com",
    async () => Response.json({ error: "Machine access revoked." }, { status: 401 })), /poll failed \(401\)/);
  assert.deepEqual(accountLinkStatus().state, "revoked");
  assert.deepEqual(log, ["[account] this computer's GrantTap sign-in is revoked (was ok): Machine access revoked.\n"]);
});
