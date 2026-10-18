import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveRuntimeConfig } from "../../../config";
import { activateConfiguredEngine } from "../activation";

test("every entry point can activate the persisted Engine declaration without LaunchAgent-only variables", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-engine-activation-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const env: NodeJS.ProcessEnv = {};
  activateConfiguredEngine(env); assert.equal(env.GRANTTAP_ENGINE_ENABLED, undefined);
  saveRuntimeConfig({ enginePath: join(root, "engine"), engineSha256: "a".repeat(64) });
  activateConfiguredEngine(env);
  assert.deepEqual(env, { GRANTTAP_ENGINE_BINARY: join(root, "engine"), GRANTTAP_ENGINE_SHA256: "a".repeat(64),
    GRANTTAP_ENGINE_ENABLED: "1", GRANTTAP_PROJECT_POLICY_ENABLED: "1" });
  const disabled = { GRANTTAP_ENGINE_ENABLED: "0" }; activateConfiguredEngine(disabled);
  assert.deepEqual(disabled, { GRANTTAP_ENGINE_ENABLED: "0" });
  const explicit = { GRANTTAP_ENGINE_BINARY: join(root, "other"), GRANTTAP_ENGINE_SHA256: "b".repeat(64),
    GRANTTAP_ENGINE_ENABLED: "true", GRANTTAP_PROJECT_POLICY_ENABLED: "0" };
  activateConfiguredEngine(explicit);
  assert.equal(explicit.GRANTTAP_ENGINE_BINARY, join(root, "other")); assert.equal(explicit.GRANTTAP_PROJECT_POLICY_ENABLED, "0");
  const partial = { GRANTTAP_ENGINE_BINARY: join(root, "partial") }; activateConfiguredEngine(partial);
  assert.deepEqual(partial, { GRANTTAP_ENGINE_BINARY: join(root, "partial") });
});

test("a Windows drive declaration survives configuration reload while network shares are rejected", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-windows-engine-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous; await rm(root, { recursive: true, force: true }); });
  saveRuntimeConfig({ enginePath: "C:\\Users\\GrantTap\\engine.exe", engineSha256: "c".repeat(64) });
  const env: NodeJS.ProcessEnv = {}; activateConfiguredEngine(env);
  assert.equal(env.GRANTTAP_ENGINE_BINARY, "C:\\Users\\GrantTap\\engine.exe");
  assert.equal(env.GRANTTAP_ENGINE_ENABLED, "1");
  saveRuntimeConfig({ enginePath: "\\\\server\\share\\engine.exe", engineSha256: "d".repeat(64) });
  const remote: NodeJS.ProcessEnv = {}; activateConfiguredEngine(remote);
  assert.equal(remote.GRANTTAP_ENGINE_ENABLED, undefined);
});
