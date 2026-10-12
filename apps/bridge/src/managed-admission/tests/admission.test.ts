import assert from "node:assert/strict";
import test from "node:test";
import { managedAdmissionOptions } from "../index";
import { saveAccountLink } from "../../account-recovery/link";
import type { PeerConfig } from "../../../../../packages/core/relay-client";

const config: PeerConfig = { relayUrl: "wss://relay.granttap.com", room: "fixture-room",
  role: "machine", deviceName: "fixture", senderId: "fixture",
  myPublicKey: "fixture-key", mySecretKey: "fixture-secret", peerPublicKey: "fixture-peer" };

test("an unlinked free-beta client does not claim paid server rights", async () => {
  assert.deepEqual(await managedAdmissionOptions(config).upgradeHeaders!(), {});
});

test("own relays never obtain a paid lease and managed authentication failures are not hidden", async () => {
  const account = { accountId: "12345678-1234-4123-8123-123456789012",
    machineId: "22345678-1234-4123-8123-123456789012", machineToken: "A".repeat(43) };
  assert.equal(saveAccountLink(account), true);
  let calls = 0;
  const request: typeof fetch = async (_url, options) => {
    calls++;
    assert.equal(options?.headers && (options.headers as Record<string, string>).authorization, `Bearer ${account.machineToken}`);
    assert.deepEqual(JSON.parse(options!.body as string), { publicKey: config.myPublicKey, room: config.room });
    return Response.json({ ticket: `ticket-${calls}`, expiresAt: Date.now() + 60_000 });
  };
  assert.deepEqual(managedAdmissionOptions({ ...config, relayUrl: "wss://own.example" }, request), {});
  assert.deepEqual(managedAdmissionOptions({ ...config, role: "phone" }, request), {});
  const options = managedAdmissionOptions(config, request);
  assert.deepEqual(await options.upgradeHeaders!(), { "X-GrantTap-Admission": "ticket-1" });
  assert.deepEqual(await options.upgradeHeaders!(), { "X-GrantTap-Admission": "ticket-2" });
  const denied = managedAdmissionOptions(config, async () => new Response(null, { status: 403 }));
  await assert.rejects(denied.upgradeHeaders!(), /computer limit/);
  for (const status of [404, 503]) {
    assert.deepEqual(await managedAdmissionOptions(config, async () => new Response(null, { status })).upgradeHeaders!(), {});
  }
  for (const body of [{}, { ticket: "bad", expiresAt: 1 }, { ticket: "bad", expiresAt: Date.now() + 600_000 }]) {
    await assert.rejects(managedAdmissionOptions(config, async () => Response.json(body)).upgradeHeaders!(), /invalid lease/);
  }
});
