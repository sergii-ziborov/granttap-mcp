import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPairing, loadConfig, machineConfigPath, saveConfig } from "../../apps/bridge/src/config";
import { confirmPendingController, controllerPeerGate, prunePendingControllers,
  rememberPendingController } from "../../apps/bridge/src/pairing/controllers";

test("an expired unclaimed QR revokes its key, while an authenticated phone keeps its key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-controller-lifecycle-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { delete process.env.GRANTTAP_CONFIG_DIR; });
  const first = createPairing("ws://127.0.0.1:1");
  const pendingKey = createPairing("ws://127.0.0.1:1").phoneCfg.myPublicKey;
  const confirmedKey = createPairing("ws://127.0.0.1:1").phoneCfg.myPublicKey;
  const machine = { ...first.machineCfg, extraPeerPublicKeys: [pendingKey, confirmedKey] };
  saveConfig(machineConfigPath(), machine);
  rememberPendingController(machine.room, pendingKey, 100);
  rememberPendingController(machine.room, confirmedKey, 100);
  const gate = controllerPeerGate(machine, () => 99);
  assert.equal(gate(first.phoneCfg.myPublicKey), true);
  assert.equal(gate(pendingKey), true);
  assert.equal(controllerPeerGate(machine, () => 101)(pendingKey), false);
  assert.equal(confirmPendingController(machine.room, pendingKey, 101), false);
  assert.equal(confirmPendingController(machine.room, first.phoneCfg.myPublicKey, 99), false);
  assert.equal(confirmPendingController(machine.room, confirmedKey, 99), true);
  assert.equal(confirmPendingController(machine.room, confirmedKey, 101), false);
  assert.equal(controllerPeerGate(machine, () => 101)(confirmedKey), true);
  const pruned = prunePendingControllers(machine, 101);
  assert.deepEqual(pruned.extraPeerPublicKeys, [confirmedKey]);
  assert.equal(controllerPeerGate(machine, () => 101)(pendingKey), false);
  assert.equal(controllerPeerGate(machine, () => 101)(confirmedKey), true);
  assert.deepEqual(loadConfig(machineConfigPath()).extraPeerPublicKeys, [confirmedKey]);
  const state = await readFile(join(root, "pending-controllers.json"), "utf8");
  assert.equal(state.includes(pendingKey), false);
  assert.equal(state.includes(confirmedKey), false);
  assert.deepEqual(prunePendingControllers(pruned, 102).extraPeerPublicKeys, [confirmedKey]);
});

test("a missing enrollment journal cannot silently bless an extra controller key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-controller-missing-journal-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { delete process.env.GRANTTAP_CONFIG_DIR; });
  const first = createPairing("ws://127.0.0.1:1");
  const unknownKey = createPairing("ws://127.0.0.1:1").phoneCfg.myPublicKey;
  const machine = { ...first.machineCfg, extraPeerPublicKeys: [unknownKey] };
  saveConfig(machineConfigPath(), machine);
  assert.equal(controllerPeerGate(machine)(unknownKey), false);
  assert.deepEqual(prunePendingControllers(machine).extraPeerPublicKeys, []);
  assert.equal(controllerPeerGate(machine)(unknownKey), false);
});
