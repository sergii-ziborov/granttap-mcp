import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair } from "../../../../../packages/core/crypto";
import { RelayClient } from "../../../../../packages/core/relay-client";
import { loadConfig, machineConfigPath, phonePairingPath, saveConfig } from "../../config";
import { controllerPeerGate, rememberPendingController } from "../../pairing/controllers";
import { createOneTimePairing } from "../../pairing";
import { readControllerLastSeenAt, recordControllerAdded, recordControllerName } from "../../pairing/presence";
import { LAST_PHONE, PhoneChangeRefused, phoneRoster, removePhoneKeys } from "..";
import { isolatedConfig, live, mailboxRelay, NOW, pairedComputer } from "./support";

test("removed phones stop being sealed for at once, in a process that loaded the pairing before", (t) => {
  const root = isolatedConfig(t);
  const f = pairedComputer(3, [0, 50, 60, 1]);
  recordControllerName(f.extras[0]!, "Old test install");
  const running = new RelayClient(f.machine, { peerAllowed: controllerPeerGate(f.machine) });
  assert.equal(running.authorizedPeers.length, 4);
  const outcome = removePhoneKeys(f.machine.room, [f.extras[0]!, f.extras[1]!], NOW);
  assert.deepEqual(outcome.removed.map((phone) => phone.key), [f.extras[0], f.extras[1]]);
  assert.equal(outcome.remaining, 2);
  assert.equal(outcome.promoted, undefined);
  assert.deepEqual(running.authorizedPeers, [f.primary, f.extras[2]], "the gate rereads the file on every send");
  assert.deepEqual(live().extraPeerPublicKeys, [f.extras[2]]);
  assert.equal(readControllerLastSeenAt(f.extras[0]!), null, "a removed phone leaves no presence behind");
  assert.equal(readFileSync(join(root, "presence.json"), "utf8").includes("Old test install"), false);
  assert.equal(readdirSync(root).some((name) => name.startsWith("machine.json.lock")), false, "the lock is released");
  assert.deepEqual(removePhoneKeys(f.machine.room, [f.extras[0]!], NOW).removed, [], "a repeat finds nothing to remove");
});

test("a stale first pairing hands its place to the phone heard from most recently", async (t) => {
  isolatedConfig(t);
  const relay = await mailboxRelay(t);
  const f = pairedComputer(3, [200, 9, 0.01, null], { relayUrl: relay });
  const unscanned = generateKeyPair().publicKey;
  rememberPendingController(f.machine.room, unscanned, NOW + 600_000);
  recordControllerAdded(unscanned, NOW);
  saveConfig(machineConfigPath(), { ...live(), extraPeerPublicKeys: [...f.extras, unscanned] });
  const before = live();
  const outcome = removePhoneKeys(f.machine.room, [f.primary], NOW);
  assert.equal(outcome.promoted?.key, f.extras[1], "the real phone, not a QR nobody scanned yet, takes the place");
  const after = live();
  assert.equal(after.peerPublicKey, f.extras[1]);
  assert.deepEqual(after.extraPeerPublicKeys, [f.extras[0], f.extras[2], unscanned]);
  const gate = controllerPeerGate(before, () => NOW);
  assert.equal(gate(f.primary), false, "the primary a running process started with is revoked from disk");
  assert.equal(gate(f.extras[1]!), true);
  assert.deepEqual(phoneRoster(after, { now: NOW }).map((phone) => phone.primary), [true, false, false, false]);

  // Offering the saved phone half again would pair a phone this computer no longer accepts.
  const reconnect = await createOneTimePairing(relay, { installHooks: false });
  assert.notEqual(reconnect.phoneCfg.myPublicKey, f.primary);
  assert.equal(reconnect.phoneCfg.peerPublicKey, after.myPublicKey);
  assert.equal(live().extraPeerPublicKeys?.includes(reconnect.phoneCfg.myPublicKey), true);
  assert.equal(loadConfig(phonePairingPath()).myPublicKey, f.primary, "the saved half is left as it was");
});

test("the last phone stays, and a changed room is not edited", (t) => {
  isolatedConfig(t);
  const f = pairedComputer(1, [400, 400]);
  assert.throws(() => removePhoneKeys(f.machine.room, [f.primary, f.extras[0]!], NOW),
    (error: unknown) => error instanceof PhoneChangeRefused && error.message === LAST_PHONE);
  assert.throws(() => removePhoneKeys("another-room", [f.extras[0]!], NOW), PhoneChangeRefused);
  assert.deepEqual(live().extraPeerPublicKeys, f.extras, "nothing was written");
});

test("a removed phone frees its place in a running relay link", (t) => {
  isolatedConfig(t);
  const f = pairedComputer(16, Array(17).fill(1));
  const running = new RelayClient({ ...f.machine }, { peerAllowed: controllerPeerGate(f.machine) });
  const newcomer = generateKeyPair().publicKey;
  removePhoneKeys(f.machine.room, [f.extras[4]!], NOW);
  saveConfig(machineConfigPath(), { ...live(), extraPeerPublicKeys: [...live().extraPeerPublicKeys!, newcomer] });
  assert.doesNotThrow(() => running.addControllerPeer(newcomer));
  assert.equal(running.authorizedPeers.length, 17);
  assert.equal(running.authorizedPeers.includes(f.extras[4]!), false);
});
