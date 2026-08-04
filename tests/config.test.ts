import assert from "node:assert/strict";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPairing,
  isGatingSkipped,
  loadRuntimeConfig,
  machineConfigPath,
  pairingUri,
  parsePairingUri,
  saveConfig,
  saveRuntimeConfig,
} from "../apps/bridge/src/config";
import { oneTimePairingUri, relayHttpBase } from "../apps/bridge/src/pairing";

test("gating can exclude exactly one chat without disabling every chat", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-config-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });

  assert.deepEqual(loadRuntimeConfig(), {
    enabled: true, excludedSessions: [], sessionAccess: {}, sessionMcpDisabled: {},
  });
  assert.equal(isGatingSkipped("chat-a"), false);

  saveRuntimeConfig({
    enabled: true,
    excludedSessions: ["chat-a"],
    sessionAccess: { "chat-a": "read-only" },
    sessionMcpDisabled: { "chat-a": ["github"] },
  });
  assert.equal(loadRuntimeConfig().sessionAccess["chat-a"], "read-only");
  assert.deepEqual(loadRuntimeConfig().sessionMcpDisabled["chat-a"], ["github"]);
  assert.equal(isGatingSkipped("chat-a"), true);
  assert.equal(isGatingSkipped("chat-b"), false);
  assert.equal((await stat(join(configDir, "config.json"))).mode & 0o777, 0o600);

  const { machineCfg } = createPairing("wss://relay.example.test");
  await writeFile(machineConfigPath(), "legacy", { mode: 0o644 });
  await chmod(machineConfigPath(), 0o644);
  saveConfig(machineConfigPath(), machineCfg);
  assert.equal((await stat(machineConfigPath())).mode & 0o777, 0o600);
  assert.match(machineCfg.room, /^[a-f0-9]{32}$/);

  saveRuntimeConfig({ enabled: false, excludedSessions: [], sessionAccess: {}, sessionMcpDisabled: {} });
  assert.equal(isGatingSkipped("chat-a"), true);
  assert.equal(isGatingSkipped(undefined), true);
});

test("legacy Nodvox environment and pairing links remain readable during migration", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-legacy-config-"));
  const current = process.env.GRANTTAP_CONFIG_DIR;
  const legacy = process.env.NODVOX_CONFIG_DIR;
  delete process.env.GRANTTAP_CONFIG_DIR;
  process.env.NODVOX_CONFIG_DIR = configDir;
  t.after(() => {
    if (current == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = current;
    if (legacy == null) delete process.env.NODVOX_CONFIG_DIR;
    else process.env.NODVOX_CONFIG_DIR = legacy;
  });

  saveRuntimeConfig({
    enabled: true, excludedSessions: ["legacy-chat"], sessionAccess: {}, sessionMcpDisabled: {},
  });
  assert.equal(isGatingSkipped("legacy-chat"), true);

  const { phoneCfg } = createPairing("ws://127.0.0.1:8787");
  const currentUri = pairingUri(phoneCfg);
  assert.match(currentUri, /^granttap:\/\/pair\?/);
  const migrated = parsePairingUri(currentUri.replace(/^granttap:/, "nodvox:"));
  assert.deepEqual(migrated, phoneCfg);
});

test("chat pairing QR separates the relay mailbox from its 256-bit transfer key", () => {
  const mailboxId = "ab".repeat(16);
  const transferKey = "S".repeat(43);
  const uri = oneTimePairingUri("wss://relay.example.test/", mailboxId, transferKey);
  const parsed = new URL(uri);

  assert.equal(parsed.protocol, "granttap:");
  assert.equal(parsed.hostname, "pair-v2");
  assert.equal(parsed.searchParams.get("v"), "2");
  assert.equal(parsed.searchParams.get("u"), "https://relay.example.test");
  assert.equal(parsed.searchParams.get("m"), mailboxId);
  assert.equal(parsed.searchParams.get("k"), transferKey);
  assert.equal(parsed.searchParams.has("s"), false);
  assert.equal(parsed.searchParams.has("p"), false);
  assert.equal(relayHttpBase("ws://127.0.0.1:8787/"), "http://127.0.0.1:8787");
});

test("pairing accepts only authenticated WebSocket relay endpoints and complete keys", () => {
  assert.throws(() => createPairing("https://relay.example.test"), /wss:\/\//);
  assert.throws(() => createPairing("wss://user:pass@relay.example.test"), /credentials/);
  assert.throws(() => createPairing("ws://relay.example.test"), /loopback/);
  assert.doesNotThrow(() => createPairing("ws://127.0.0.1:8787"));

  const { phoneCfg } = createPairing("wss://relay.example.test/");
  const valid = pairingUri(phoneCfg);
  assert.equal(parsePairingUri(valid)?.relayUrl, "wss://relay.example.test");
  assert.equal(parsePairingUri(valid.replace("v=1", "v=9")), null);
  assert.equal(parsePairingUri(valid.replace(/([?&])k=[^&]+/, "$1k=short")), null);
  assert.equal(parsePairingUri(valid.replace("wss%3A%2F%2F", "https%3A%2F%2F")), null);
});
