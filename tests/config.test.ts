import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPairing,
  isGatingSkipped,
  loadRuntimeConfig,
  pairingUri,
  parsePairingUri,
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

test("chat pairing QR carries only a short-lived code and relay address", () => {
  const uri = oneTimePairingUri("wss://relay.example.test/", "abcd-2345");
  const parsed = new URL(uri);

  assert.equal(parsed.protocol, "granttap:");
  assert.equal(parsed.hostname, "pair-code");
  assert.equal(parsed.searchParams.get("v"), "1");
  assert.equal(parsed.searchParams.get("u"), "https://relay.example.test");
  assert.equal(parsed.searchParams.get("c"), "ABCD2345");
  assert.equal(parsed.searchParams.has("s"), false);
  assert.equal(parsed.searchParams.has("p"), false);
  assert.equal(relayHttpBase("ws://127.0.0.1:8787/"), "http://127.0.0.1:8787");
});
