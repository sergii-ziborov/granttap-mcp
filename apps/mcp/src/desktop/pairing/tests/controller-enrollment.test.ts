import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPairing, loadConfig, machineConfigPath, phonePairingPath, saveConfig } from "../../../../../bridge/src/config";
import { recordPhoneSeen } from "../../../../../bridge/src/pairing/presence";
import { confirmPendingController } from "../../../../../bridge/src/pairing/controllers";
import { DesktopControllerEnrollment } from "..";

test("Mac issues a one-time independent controller QR only after the user action", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-desktop-pairing-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR; await rm(root, { recursive: true, force: true }); });
  let publications = 0;
  const server = createServer((req, res) => {
    assert.equal(req.method, "PUT");
    assert.match(req.url!, /^\/pair\/[a-f0-9]{32}$/);
    publications++;
    req.resume();
    req.on("end", () => { res.writeHead(200); res.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const original = createPairing(`ws://127.0.0.1:${port}`);
  saveConfig(machineConfigPath(), original.machineCfg);
  saveConfig(phonePairingPath(), original.phoneCfg);
  let changes = 0;
  const enrollment = new DesktopControllerEnrollment(() => { changes++; });
  assert.equal((await enrollment.read({ action: "status" }))?.status, "idle");
  for (const input of [undefined, null, [], {}, { action: "create" },
    { action: "create", confirmed: "false" }, { action: "create", confirmed: "true", replace: "true" }, { action: "replace", confirmed: "true" }]) {
    assert.equal(await enrollment.read(input), undefined);
  }
  assert.equal(publications, 0);
  const [first, simultaneous] = await Promise.all([
    enrollment.read({ action: "create", confirmed: "true" }),
    enrollment.read({ action: "create", confirmed: "true" }),
  ]);
  assert.equal(first?.status, "pending");
  assert.match(first?.uri ?? "", /^granttap:\/\/pair-v2\?/);
  assert.equal(simultaneous?.uri, first?.uri);
  assert.equal(publications, 1);
  assert.equal(changes, 1);
  const updated = loadConfig(machineConfigPath());
  assert.equal(updated.room, original.machineCfg.room);
  assert.equal(updated.myPublicKey, original.machineCfg.myPublicKey);
  assert.equal(updated.peerPublicKey, original.machineCfg.peerPublicKey);
  assert.deepEqual(loadConfig(phonePairingPath()), original.phoneCfg);
  const newKey = updated.extraPeerPublicKeys![0]!;
  assert.notEqual(newKey, original.phoneCfg.myPublicKey);
  recordPhoneSeen(Date.now(), original.phoneCfg.myPublicKey);
  assert.equal((await enrollment.read({ action: "status" }))?.status, "pending");
  const now = Date.now();
  confirmPendingController(updated.room, newKey, now);
  recordPhoneSeen(now, newKey);
  const completed = await enrollment.read({ action: "status" });
  assert.equal(completed?.status, "connected");
  assert.equal(completed?.uri, undefined);
  const encoded = JSON.stringify(completed);
  for (const secret of [first!.uri!, original.machineCfg.mySecretKey, newKey]) {
    assert.equal(encoded.includes(secret), false);
  }
  recordPhoneSeen(first!.expires_at! + 1, newKey);
  assert.equal(enrollment.snapshot(first!.expires_at! + 2).status, "connected");
  enrollment.close();
  assert.equal((await enrollment.read({ action: "status" }))?.status, "idle");
});

test("expired QR is not displayed and relay failure keeps the working pairing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-desktop-pairing-expiry-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR; await rm(root, { recursive: true, force: true }); });
  const server = createServer((req, res) => { req.resume(); res.writeHead(200); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const original = createPairing(`ws://127.0.0.1:${port}`);
  saveConfig(machineConfigPath(), original.machineCfg);
  saveConfig(phonePairingPath(), original.phoneCfg);
  const enrollment = new DesktopControllerEnrollment();
  const first = await enrollment.read({ action: "create", confirmed: "true" });
  const expired = enrollment.snapshot(first!.expires_at! + 1);
  assert.equal(expired.status, "expired");
  assert.equal(expired.uri, undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  enrollment.close();
  const failed = await enrollment.read({ action: "create", confirmed: "true" });
  assert.equal(failed?.status, "unavailable");
  assert.equal(failed?.uri, undefined);
  assert.equal(loadConfig(machineConfigPath()).room, original.machineCfg.room);
  assert.equal(loadConfig(machineConfigPath()).peerPublicKey, original.machineCfg.peerPublicKey);
});
