import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPairing } from "../../apps/bridge/src/config";
import { recordPhoneSeen } from "../../apps/bridge/src/pairing/presence";
import { rememberPendingController } from "../../apps/bridge/src/pairing/controllers";
import { listPairedPhones, phoneReachability } from "../../apps/mcp/src/status/pairing-status";
import { RelayClient } from "../../packages/core/relay-client";
import { forwardingRelay, waitFor } from "../support/forwarding-relay";

function isolate(t: { after: (fn: () => void) => void }): string {
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), "granttap-hook-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  return root;
}

test("healthz reachability is unknown without a pairing, live only while seen", (t) => {
  isolate(t);
  assert.equal(phoneReachability(), "unknown");
  assert.equal(phoneReachability([]), "unknown");
  assert.equal(phoneReachability([{ name: "iPhone", status: "paired", lastSeenAt: 1 }]), "offline");
  assert.equal(phoneReachability([{ name: "iPhone", status: "seen", lastSeenAt: Date.now() }]), "live");
});

test("a mailbox scan that records presence flips the phone from offline to live", (t) => {
  isolate(t);
  const { machineCfg } = createPairing("wss://relay.granttap.com");
  writeFileSync(join(process.env.GRANTTAP_CONFIG_DIR!, "machine.json"), JSON.stringify(machineCfg));
  assert.equal(phoneReachability(), "offline");
  recordPhoneSeen();
  const phones = listPairedPhones();
  assert.equal(phones[0]?.status, "seen");
  assert.equal(phoneReachability(phones), "live");
});

test("controller activity identifies the exact phone without marking its peer live", (t) => {
  const root = isolate(t);
  const { machineCfg } = createPairing("wss://relay.granttap.com");
  const second = createPairing("wss://relay.granttap.com").phoneCfg.myPublicKey;
  writeFileSync(join(root, "machine.json"), JSON.stringify({
    ...machineCfg, extraPeerPublicKeys: [second],
  }));
  const now = Date.now();
  rememberPendingController(machineCfg.room, second, now + 60_000);
  recordPhoneSeen(now, second);
  const phones = listPairedPhones(null, now);
  assert.equal(phones.length, 2);
  assert.equal(phones[0]?.status, "paired");
  assert.equal(phones[1]?.status, "seen");
  assert.equal(phoneReachability(phones), "live");
  recordPhoneSeen(now, machineCfg.peerPublicKey);
  assert.deepEqual(listPairedPhones(null, now).map((phone) => phone.status), ["seen", "seen"]);
});

test("corrupt pairing data is reported as unconfigured", (t) => {
  const root = isolate(t);
  writeFileSync(join(root, "machine.json"), "not-json");
  assert.deepEqual(listPairedPhones(), []);
  assert.equal(phoneReachability(), "unknown");
});

test("Mac / and iPhone /ws exchange hello on the same room", async (t) => {
  const relay = await forwardingRelay();
  t.after(() => relay.close());
  const { machineCfg, phoneCfg } = createPairing(relay.url);
  phoneCfg.relayUrl = `${relay.url}/ws`;
  const machine = new RelayClient(machineCfg, { minReconnectMs: 50 });
  const phone = new RelayClient(phoneCfg, { minReconnectMs: 50 });
  t.after(() => {
    machine.close();
    phone.close();
  });

  const phoneHello = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("machine did not receive phone hello")), 2_000);
    machine.onMessage((payload) => {
      if (payload.type === "hello" && payload.role === "phone") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const machineHello = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("phone did not receive machine hello")), 2_000);
    phone.onMessage((payload) => {
      if (payload.type === "hello" && payload.role === "machine") {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  await machine.connect();
  await phone.connect();
  await waitFor(() => relay.connections() === 2, 2_000);
  await machine.send({
    type: "hello", role: "machine", deviceName: machineCfg.deviceName, createdAt: Date.now(),
  }, "all");
  await phone.send({
    type: "hello", role: "phone", deviceName: phoneCfg.deviceName, createdAt: Date.now(),
  }, "all");
  await Promise.all([phoneHello, machineHello]);
});
