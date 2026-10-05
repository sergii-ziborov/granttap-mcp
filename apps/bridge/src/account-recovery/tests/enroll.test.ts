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
  let renames = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const path = String(input);
    const authorization = (init?.headers as Record<string, string>).authorization;
    assert.equal(authorization, `Bearer ${path.endsWith("machine/identity") || path.endsWith("machine/self")
      ? machineToken : token}`);
    if (String(input).endsWith("/api/account/me")) return Response.json({ accountId });
    if (path.endsWith("machine/identity")) return Response.json({ accountId, machineId });
    if (path.endsWith("machine/self")) {
      renames++;
      assert.equal(init?.method, "PATCH");
      assert.deepEqual(JSON.parse(String(init?.body)), { name: "Serhii’s MacBook Pro" });
      return Response.json({ renamed: true });
    }
    registrations++;
    assert.ok(String(input).endsWith("/api/account/machines"));
    assert.deepEqual(JSON.parse(String(init?.body)), { name: "Serhii’s MacBook Pro" });
    return Response.json({ id: machineId, machineToken, name: "Mac" });
  };
  const name = () => "Serhii’s MacBook Pro";
  assert.deepEqual(await enrollMacAccount(token, "https://granttap.com", fakeFetch, name),
    { accountId, machineId });
  assert.deepEqual(loadAccountLink(), { accountId, machineId, machineToken });
  assert.deepEqual(await enrollMacAccount(token, "https://granttap.com", fakeFetch, name),
    { accountId, machineId });
  assert.equal(registrations, 1);
  assert.equal(renames, 1);
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
    if (String(input).endsWith("/api/account/machine/identity")) {
      return revoked ? new Response(null, { status: 401 }) : Response.json({ accountId, machineId: oldId });
    }
    if (!registered) { registered = true; return Response.json({ id: oldId, machineToken: "B".repeat(43) }); }
    return Response.json({ id: newId, machineToken: "C".repeat(43) });
  };
  await enrollMacAccount("A".repeat(43), "https://granttap.com", fakeFetch);
  revoked = true;
  assert.deepEqual(await enrollMacAccount("A".repeat(43), "https://granttap.com", fakeFetch),
    { accountId, machineId: newId });
  assert.equal(loadAccountLink()?.machineToken, "C".repeat(43));
});
