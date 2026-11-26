import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AccountAdmissionError, managedAdmissionOptions, usesManagedRelay } from "../index";
import { saveAccountLink } from "../../account-recovery/link";
import { accountLinkStatus, resetAccountCheckFailures } from "../../account-link-state";
import type { PeerConfig } from "../../../../../packages/core/relay-client";

const config: PeerConfig = { relayUrl: "wss://relay.granttap.com", room: "fixture-room",
  role: "machine", deviceName: "fixture", senderId: "fixture",
  myPublicKey: "fixture-key", mySecretKey: "fixture-secret", peerPublicKey: "fixture-peer" };

async function privateConfig(t: TestContext): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "granttap-admission-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetAccountCheckFailures();
  t.mock.method(process.stderr, "write", () => true);
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR; await rm(root, { recursive: true, force: true }); });
}

test("an unlinked client must sign in before obtaining managed access", async t => {
  await privateConfig(t);
  await assert.rejects(managedAdmissionOptions(config).upgradeHeaders!(),
    (error: unknown) => error instanceof AccountAdmissionError && error.state === "none" && /granttap sign-in/.test(error.message));
  assert.equal(usesManagedRelay(config.relayUrl), true);
  assert.equal(usesManagedRelay("wss://own.example"), false);
});

test("a refused admission says whether the sign-in or the subscription is the problem, and is kept as the state", async t => {
  await privateConfig(t);
  saveAccountLink({ accountId: "12345678-1234-4123-8123-123456789012",
    machineId: "22345678-1234-4123-8123-123456789012", machineToken: "A".repeat(43) });
  const answering = (response: () => Response) => managedAdmissionOptions(config, async () => response()).upgradeHeaders!();
  await assert.rejects(answering(() => Response.json({ code: "seat_limit", error: "Every computer place is in use." },
    { status: 403 })), (error: unknown) => error instanceof AccountAdmissionError && error.state === "seat_limit"
    && /not covered by your GrantTap subscription: Every computer place is in use\./.test(error.message));
  assert.equal(accountLinkStatus().state, "seat_limit");
  await assert.rejects(answering(() => Response.json({ code: "subscription_required" }, { status: 403 })),
    (error: unknown) => error instanceof AccountAdmissionError && error.state === "no_subscription");
  assert.equal(accountLinkStatus().state, "no_subscription");
  await assert.rejects(answering(() => Response.json({ error: "Machine access revoked." }, { status: 401 })),
    (error: unknown) => error instanceof AccountAdmissionError && error.state === "revoked"
      && /signed out of your GrantTap account\. Sign it in again: granttap sign-in/.test(error.message));
  assert.deepEqual(accountLinkStatus().state, "revoked");
  for (let i = 0; i < 4; i++) {
    await assert.rejects(managedAdmissionOptions(config, async () => { throw new TypeError("fetch failed"); }).upgradeHeaders!(),
      /could not be verified/);
  }
  assert.equal(accountLinkStatus().state, "revoked", "an unreachable service never hides a revoked sign-in");
});

test("own relays never obtain a paid lease and managed authentication failures are not hidden", async t => {
  await privateConfig(t);
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
    await assert.rejects(managedAdmissionOptions(config, async () => new Response(null, { status })).upgradeHeaders!(),
      /could not be verified/);
  }
  for (const body of [{}, { ticket: "bad", expiresAt: 1 }, { ticket: "bad", expiresAt: Date.now() + 600_000 }]) {
    await assert.rejects(managedAdmissionOptions(config, async () => Response.json(body)).upgradeHeaders!(), /invalid lease/);
  }
});
