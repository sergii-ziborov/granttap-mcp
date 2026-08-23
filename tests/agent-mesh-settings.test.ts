import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigSet,
  ProviderRuntimeSettings,
  SessionsStatus,
} from "../packages/protocol/schema";
import {
  isMeshEnabled,
  isProviderEnabled,
  loadRuntimeConfig,
  saveRuntimeConfig,
} from "../apps/bridge/src/config/runtime";

test("agent and mesh settings are bounded protocol state", () => {
  assert.equal(ProviderRuntimeSettings.safeParse({
    claude: true, codex: true, cursor: false, grok: true,
  }).success, true);
  assert.equal(ProviderRuntimeSettings.safeParse({
    claude: true, codex: true, cursor: true, grok: true, copilot: true,
  }).success, false);
  assert.equal(ConfigSet.safeParse({
    type: "config.set", provider: "cursor", providerEnabled: false,
    meshEnabled: false, createdAt: 1,
  }).success, true);
  assert.equal(ConfigSet.safeParse({
    type: "config.set", provider: "copilot", providerEnabled: false, createdAt: 1,
  }).success, false);
  assert.equal(SessionsStatus.safeParse({
    type: "sessions.status", machine: "Mac", sessions: [], tokensRecent: 0,
    tokenWindowHours: 12, providerSettings: {
      claude: true, codex: true, cursor: false, grok: true,
    }, meshEnabled: false, generatedAt: 1,
  }).success, true);
});

test("runtime defaults preserve four agents and Mesh, then persist exact gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-agent-mesh-settings-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  const defaults = loadRuntimeConfig();
  assert.deepEqual(defaults.providerSettings, {
    claude: true, codex: true, cursor: true, grok: true,
  });
  assert.equal(defaults.meshEnabled, true);
  assert.equal(isProviderEnabled("grok"), true);
  assert.equal(isMeshEnabled(), true);

  saveRuntimeConfig({
    providerSettings: { ...defaults.providerSettings, cursor: false },
    meshEnabled: false,
  });
  assert.equal(isProviderEnabled("cursor"), false);
  assert.equal(isProviderEnabled("claude"), true);
  assert.equal(isMeshEnabled(), false);
  const persisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(persisted.providerSettings.cursor, false);
  assert.equal(persisted.meshEnabled, false);
  delete process.env.GRANTTAP_CONFIG_DIR;
});
