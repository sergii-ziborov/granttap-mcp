import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DeviceManagementSnapshot, PairedPhoneEntry } from "../../../../../packages/protocol/schema";
import { machineConfigPath, saveConfig } from "../../config";
import { rememberPendingController } from "../../pairing/controllers";
import { recordControllerName } from "../../pairing/presence";
import { idleFor, lastActivity, longestIdle, mostRecentPhone, phoneEntries, phoneId, phoneRoster, stalePhones }
  from "..";
import { DAY, isolatedConfig, live, NOW, pairedComputer } from "./support";

test("each phone is named by a hash of its key, never the key, with its first pairing, names and times", (t) => {
  isolatedConfig(t);
  const f = pairedComputer(2, [3, null, 0.5]);
  recordControllerName(f.extras[1]!, "Travel iPad");
  const roster = phoneRoster(live(), { now: NOW });
  assert.deepEqual(roster.map((phone) => phone.key), [f.primary, ...f.extras]);
  assert.equal(roster[0]!.id, createHash("sha256").update(f.primary).digest("hex"));
  assert.equal(roster[0]!.label, roster[0]!.id.slice(0, 6));
  assert.deepEqual(roster.map((phone) => phone.primary), [true, false, false]);
  assert.deepEqual(roster.map((phone) => phone.lastSeenAt), [NOW - 3 * DAY, null, NOW - 0.5 * DAY]);
  assert.deepEqual(roster.map((phone) => phone.addedAt), [null, NOW - 400 * DAY, NOW - 400 * DAY]);
  assert.deepEqual(roster.map((phone) => phone.name), [null, null, "Travel iPad"]);

  const entries = phoneEntries(roster, f.extras[1]);
  for (const entry of entries) assert.equal(PairedPhoneEntry.safeParse(entry).success, true);
  assert.deepEqual(entries.map((entry) => entry.thisPhone), [false, false, true]);
  assert.equal(entries[0]!.addedAt, undefined, "an unknown time is absent, not zero");
  assert.equal(JSON.stringify(entries).includes(f.primary), false, "no public key leaves the computer");
  assert.equal(DeviceManagementSnapshot.shape.phones.safeParse(entries).success, true);
});

test("idle time counts from the later of last seen and added; an open QR is never idle", (t) => {
  isolatedConfig(t);
  const f = pairedComputer(3, [40, 2, null, 31]);
  const fresh = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMTI=";
  rememberPendingController(f.machine.room, fresh, NOW + 10 * 60_000);
  saveConfig(machineConfigPath(), { ...live(), extraPeerPublicKeys: [...f.extras, fresh] });
  const roster = phoneRoster(live(), { now: NOW });
  assert.equal(roster.at(-1)!.pending, true);
  assert.deepEqual(roster.map((phone) => idleFor(phone, 30, NOW)), [true, false, true, true, false]);
  assert.equal(lastActivity(roster[2]!), NOW - 400 * DAY, "never seen falls back to when it was added");
  assert.equal(longestIdle(roster.filter((phone) => idleFor(phone, 30, NOW)))?.key, f.extras[1],
    "added 400 days ago and never seen is the longest idle");
  assert.equal(longestIdle([]), undefined);
  assert.equal(phoneId(fresh).length, 64);
});

test("a QR key that expired unscanned is not a phone; the first pairing is always listed", (t) => {
  isolatedConfig(t);
  const f = pairedComputer(1, [1, 1]);
  const expired = "YmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vMTI=";
  rememberPendingController(f.machine.room, expired, NOW - 1);
  saveConfig(machineConfigPath(), { ...live(), extraPeerPublicKeys: [...f.extras, expired, f.primary] });
  const roster = phoneRoster(live(), { now: NOW });
  assert.deepEqual(roster.map((phone) => phone.key), [f.primary, f.extras[0]], "expired and duplicate keys are left out");
});

test("a stale choice never takes the phone heard from most recently, even when every phone has been away", (t) => {
  isolatedConfig(t);
  const f = pairedComputer(3, [45, 40, null, 90]);
  const roster = phoneRoster(live(), { now: NOW });
  assert.equal(mostRecentPhone(roster)?.key, f.extras[0], "40 days ago is the most recent");
  assert.deepEqual(stalePhones(roster, 30, NOW).map((phone) => phone.key), [f.primary, f.extras[1], f.extras[2]]);
  assert.deepEqual(stalePhones(roster, 60, NOW).map((phone) => phone.key), [f.extras[1], f.extras[2]],
    "45 days is not 60; never seen but added 400 days ago is");
  assert.equal(mostRecentPhone([]), undefined);
  assert.deepEqual(stalePhones([], 30, NOW), []);
});

test("without any last-seen time the latest added phone counts as most recent, the first pairing among equals", (t) => {
  isolatedConfig(t);
  const f = pairedComputer(2, []);
  const roster = phoneRoster(live(), { now: NOW });
  assert.equal(mostRecentPhone(roster)?.key, f.extras[0], "added 400 days ago beats no time at all");
  assert.equal(mostRecentPhone([roster[1]!, roster[2]!])?.key, f.extras[0], "equal times keep roster order");
  assert.equal(stalePhones(roster.slice(0, 1), 30, NOW).length, 0, "the only phone is never stale");
});
