import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPairing, machineConfigPath, phonePairingPath, saveConfig } from "../../apps/bridge/src/config";
import { resetLocalMeshStore } from "../../apps/bridge/src/mesh/local-remote/local";
import { resetComputerIdentity } from "../../apps/bridge/src/mesh/identity/computer";
import { buildConnectSnapshot, publicClientName } from "../../apps/mcp/src/oauth/session/connect-snapshot";

test("connect snapshot lists the saved phone and Mesh without secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-connect-snapshot-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetComputerIdentity();
  resetLocalMeshStore();
  t.after(() => {
    resetComputerIdentity();
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
  });
  const pairing = createPairing("wss://relay.example.test");
  saveConfig(machineConfigPath(), pairing.machineCfg);
  saveConfig(phonePairingPath(), pairing.phoneCfg);

  const snapshot = buildConnectSnapshot("Cursor");
  assert.equal(snapshot.clientName, "Cursor");
  assert.equal(snapshot.paired, true);
  assert.equal(snapshot.roomPrefix, pairing.machineCfg.room.slice(0, 8));
  assert.equal(snapshot.phones[0]?.name, "iPhone");
  assert.equal(snapshot.mesh.present, false);
  assert.ok(snapshot.mesh.thisComputer);
  assert.ok(snapshot.mesh.computers.includes(snapshot.mesh.thisComputer));
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  assert.equal(JSON.stringify(snapshot).includes(pairing.machineCfg.room), false);
});

test("a nameless coding app is still labeled for the website", () => {
  assert.equal(publicClientName(""), "Coding app");
  assert.equal(publicClientName("   "), "Coding app");
  assert.equal(publicClientName("Cursor"), "Cursor");
});
