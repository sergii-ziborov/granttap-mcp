import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { generateKeyPair } from "../../../../../packages/core/crypto";
import { RelayClient } from "../../../../../packages/core/relay-client";
import type { ControllerPairOffer } from "../../../../../packages/protocol/schema";
import { createRecoveryOffer } from "../../account-recovery/offer";
import { handleControllerPairRequest } from "../../monitor/controller-knowledge";
import { createOneTimePairing } from "../../pairing";
import { controllerPeerGate, rememberPendingController } from "../../pairing/controllers";
import { readControllerAddedAt, readControllerLastSeenAt, recordControllerAdded } from "../../pairing/presence";
import { EVICTION_IDLE_HOURS, evictionFor, PHONE_LIMIT_REACHED, PhoneLimitReached } from "..";
import { DAY, isolatedConfig, live, mailboxRelay, NOW, pairedComputer } from "./support";

/** The first pairing idle 400 days, then sixteen added phones seen `days` ago. */
function seen(days: Array<number | null>): Array<number | null> {
  return [400, ...days];
}

/** Refused at the limit, with how many phones the computer accepts. */
function limitReached(error: unknown): boolean {
  return error instanceof PhoneLimitReached && error.message === PHONE_LIMIT_REACHED && error.phones === 17;
}

test("at the limit a new phone takes the place of the added phone idle longest, never a recent one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  isolatedConfig(t);
  const relay = await mailboxRelay(t);
  const days = Array<number | null>(16).fill(0);
  days[2] = 8; days[9] = 45;
  const f = pairedComputer(16, seen(days), { relayUrl: relay });
  assert.equal(evictionFor(live(), NOW)?.key, f.extras[9]);

  const first = await createOneTimePairing(relay, { installHooks: false, addController: true });
  const afterFirst = live();
  assert.equal(afterFirst.peerPublicKey, f.primary, "the first pairing is never taken, however idle");
  assert.equal(afterFirst.extraPeerPublicKeys?.length, 16);
  assert.equal(afterFirst.extraPeerPublicKeys?.includes(f.extras[9]!), false);
  assert.equal(afterFirst.extraPeerPublicKeys?.at(-1), first.phoneCfg.myPublicKey);
  assert.equal(readControllerAddedAt(first.phoneCfg.myPublicKey), NOW);
  assert.equal(readControllerLastSeenAt(f.extras[9]!), null);

  await createOneTimePairing(relay, { installHooks: false, addController: true });
  assert.equal(live().extraPeerPublicKeys?.includes(f.extras[2]!), false, "then the one idle 8 days");

  const before = live();
  await assert.rejects(createOneTimePairing(relay, { installHooks: false, addController: true }), limitReached);
  assert.deepEqual(live(), before, "a refused phone changes nothing");
  assert.match(PHONE_LIMIT_REACHED, /^This computer already has 17 phones, and each was used in the last day\. /);
});

test("an added phone gives its place once it has been idle 24 hours, not a moment sooner", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  isolatedConfig(t);
  const f = pairedComputer(16, seen([...Array<number>(15).fill(0), 1]));
  assert.equal(EVICTION_IDLE_HOURS, 24);
  assert.equal(evictionFor(live(), NOW)?.key, f.extras[15], "seen exactly 24 hours ago");
  assert.throws(() => evictionFor(live(), NOW - 1), limitReached, "seen 1 ms less than 24 hours ago");
});

test("the first pairing, a phone whose QR is still open and a phone added within a day keep their places", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  isolatedConfig(t);
  const days = Array<number | null>(16).fill(0);
  days[0] = 30; days[1] = null;
  const f = pairedComputer(16, seen(days));
  const open = f.extras[0]!, added = f.extras[1]!;
  rememberPendingController(f.machine.room, open, NOW + 5 * 60_000);
  recordControllerAdded(added, NOW - DAY + 1);
  assert.throws(() => evictionFor(live(), NOW), limitReached, "idle 400 days, the first pairing still stays");
  assert.equal(evictionFor(live(), NOW + 1)?.key, added, "added 24 hours ago and never seen since");
  assert.equal(evictionFor({ ...live(), extraPeerPublicKeys: f.extras.slice(1) }, NOW), null, "below the limit");
});

test("the phone app's request for another code and an account link both make room the same way", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  isolatedConfig(t);
  const relay = await mailboxRelay(t);
  const days = Array<number | null>(16).fill(0);
  days[7] = null;
  days[11] = 8;
  const f = pairedComputer(16, seen(days), { relayUrl: relay });
  const running = new RelayClient({ ...f.machine }, { peerAllowed: controllerPeerGate(f.machine) });
  const offers: ControllerPairOffer[] = [];
  const transport = { room: f.machine.room, addControllerPeer: (key: string) => running.addControllerPeer(key),
    sendToPeer: async (offer: ControllerPairOffer) => { offers.push(offer); } };
  await handleControllerPairRequest(transport as unknown as RelayClient,
    { type: "controller.pair.request", requestId: randomUUID(), createdAt: NOW }, f.extras[0]!);
  assert.equal(offers[0]?.status, "ready", "the limit no longer refuses a new phone");
  assert.equal(live().extraPeerPublicKeys?.includes(f.extras[7]!), false, "never seen in 400 days goes first");
  assert.equal(running.authorizedPeers.length, 17);

  const phone = Buffer.from(generateKeyPair().publicKey, "base64").toString("base64url");
  createRecoveryOffer({ id: randomUUID(), phonePublicKey: phone, expiresAt: NOW + 60_000 }, randomUUID());
  assert.equal(live().extraPeerPublicKeys?.includes(f.extras[11]!), false,
    "then the one away 8 days, as a reinstalled phone's old key is");
  assert.equal(live().extraPeerPublicKeys?.length, 16);
});
