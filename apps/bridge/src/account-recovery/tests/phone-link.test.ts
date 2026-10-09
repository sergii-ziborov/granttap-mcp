import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptPhoneAccountLink } from "../phone-link";
import { loadAccountLink, saveAccountLink } from "../link";

const accountId = "11111111-1111-4111-8111-111111111111";
const machineId = "22222222-2222-4222-8222-222222222222";
const machineToken = "B".repeat(43);
const payload = { type: "account.machine.link" as const, accountId,
  machineId, machineToken, createdAt: Date.now() };

test("QR-authorized phone links this Mac only with a verified machine credential", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-phone-account-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  const valid: typeof fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${machineToken}`);
    return Response.json({ accountId, machineId });
  };
  assert.equal(await acceptPhoneAccountLink(payload, "https://granttap.com", valid), true);
  assert.deepEqual(loadAccountLink(), { accountId, machineId, machineToken });
  assert.equal(await acceptPhoneAccountLink({ ...payload, machineId: crypto.randomUUID() },
    "https://granttap.com", valid), false);
});

test("a mismatched account cannot replace a linked Mac", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-phone-account-other-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  saveAccountLink({ accountId, machineId, machineToken });
  const different = { ...payload, accountId: "33333333-3333-4333-8333-333333333333" };
  let contacted = false;
  assert.equal(await acceptPhoneAccountLink(different, "https://granttap.com",
    async () => { contacted = true; return Response.json({}); }), false);
  assert.equal(contacted, false);
  assert.deepEqual(loadAccountLink(), { accountId, machineId, machineToken });
});

test("a QR link cannot replace this Mac's existing account machine", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-phone-account-refresh-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  const old = { accountId, machineId: crypto.randomUUID(), machineToken: "C".repeat(43) };
  saveAccountLink(old);
  let contacted = false;
  assert.equal(await acceptPhoneAccountLink(payload, "https://granttap.com",
    async () => { contacted = true; return Response.json({ accountId, machineId }); }), false);
  assert.equal(contacted, false);
  assert.deepEqual(loadAccountLink(), old);
});
