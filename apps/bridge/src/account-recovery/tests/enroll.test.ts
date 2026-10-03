import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enrollMacAccount } from "../enroll";
import { loadAccountLink } from "../link";

test("Mac app passkey session links the local MCP as one revocable machine", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-account-enroll-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  const accountId = "11111111-1111-4111-8111-111111111111";
  const machineId = "22222222-2222-4222-8222-222222222222";
  const token = "A".repeat(43);
  const machineToken = "B".repeat(43);
  let registrations = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${token}`);
    if (String(input).endsWith("/api/account/me")) return Response.json({ accountId });
    if (init?.method !== "POST") return Response.json({ machines: [{ id: machineId }] });
    registrations++;
    assert.ok(String(input).endsWith("/api/account/machines"));
    return Response.json({ id: machineId, machineToken, name: "Mac" });
  };
  assert.deepEqual(await enrollMacAccount(token, "https://granttap.com", fakeFetch),
    { accountId, machineId });
  assert.deepEqual(loadAccountLink(), { accountId, machineId, machineToken });
  assert.deepEqual(await enrollMacAccount(token, "https://granttap.com", fakeFetch),
    { accountId, machineId });
  assert.equal(registrations, 1);
});

test("signing in again can relink a Mac whose account access was revoked", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-account-relink-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true }); });
  const accountId = "11111111-1111-4111-8111-111111111111";
  const oldId = "22222222-2222-4222-8222-222222222222";
  const newId = "33333333-3333-4333-8333-333333333333";
  let registered = false;
  let revoked = false;
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/account/me")) return Response.json({ accountId });
    if (init?.method !== "POST") return Response.json({ machines: revoked ? [] : [{ id: oldId }] });
    if (!registered) { registered = true; return Response.json({ id: oldId, machineToken: "B".repeat(43) }); }
    return Response.json({ id: newId, machineToken: "C".repeat(43) });
  };
  await enrollMacAccount("A".repeat(43), "https://granttap.com", fakeFetch);
  revoked = true;
  assert.deepEqual(await enrollMacAccount("A".repeat(43), "https://granttap.com", fakeFetch),
    { accountId, machineId: newId });
  assert.equal(loadAccountLink()?.machineToken, "C".repeat(43));
});
