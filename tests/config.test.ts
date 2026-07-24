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

test("gating can exclude exactly one chat without disabling every chat", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-config-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });

  assert.deepEqual(loadRuntimeConfig(), { enabled: true, excludedSessions: [] });
  assert.equal(isGatingSkipped("chat-a"), false);

  saveRuntimeConfig({ enabled: true, excludedSessions: ["chat-a"] });
  assert.equal(isGatingSkipped("chat-a"), true);
  assert.equal(isGatingSkipped("chat-b"), false);

  saveRuntimeConfig({ enabled: false, excludedSessions: [] });
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

  saveRuntimeConfig({ enabled: true, excludedSessions: ["legacy-chat"] });
  assert.equal(isGatingSkipped("legacy-chat"), true);

  const { phoneCfg } = createPairing("ws://127.0.0.1:8787");
  const currentUri = pairingUri(phoneCfg);
  assert.match(currentUri, /^granttap:\/\/pair\?/);
  const migrated = parsePairingUri(currentUri.replace(/^granttap:/, "nodvox:"));
  assert.deepEqual(migrated, phoneCfg);
});
