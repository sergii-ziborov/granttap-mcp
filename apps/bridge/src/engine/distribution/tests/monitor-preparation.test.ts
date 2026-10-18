import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig, saveRuntimeConfig } from "../../../config";
import { prepareMonitorEngine, type EngineArtifact } from "..";

const bytes = Buffer.from("verified synthetic Engine for a new computer\n");
const artifact: EngineArtifact = { version: "0.1.1", platform: "linux", arch: "x64",
  bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "granttap-monitor-engine-")));
  const previous = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("a paired monitor installs and persists the Engine without a separate setup command", async t => {
  await fixture(t);
  saveRuntimeConfig({ autoAcceptDefault: "ask", enginePath: null, engineSha256: null });
  const env: NodeJS.ProcessEnv = {};
  assert.equal(await prepareMonitorEngine({ env, artifact, fetcher: async () => new Response(bytes) }), true);
  const saved = loadRuntimeConfig();
  assert.deepEqual(await readFile(saved.enginePath!), bytes);
  assert.equal(saved.engineSha256, artifact.sha256);
  assert.equal(saved.autoAcceptDefault, "ask");
  assert.equal(env.GRANTTAP_ENGINE_BINARY, saved.enginePath);
  assert.equal(env.GRANTTAP_ENGINE_ENABLED, "1");
  assert.equal(env.GRANTTAP_PROJECT_POLICY_ENABLED, "1");
});

test("a failed download leaves the declaration intact and the next monitor attempt repairs it", async t => {
  await fixture(t);
  const env: NodeJS.ProcessEnv = {};
  await assert.rejects(prepareMonitorEngine({ env, artifact, fetcher: async () => new Response(null, { status: 503 }) }));
  assert.equal(loadRuntimeConfig().enginePath, null);
  assert.equal(env.GRANTTAP_ENGINE_ENABLED, undefined);
  assert.equal(await prepareMonitorEngine({ env, artifact, fetcher: async () => new Response(bytes) }), true);
  assert.equal(loadRuntimeConfig().engineSha256, artifact.sha256);
});

test("explicit disablement, partial overrides and custom installations never trigger a download", async t => {
  const root = await fixture(t);
  const fetcher: typeof fetch = async () => { throw new Error("Network must stay idle"); };
  for (const env of [{ GRANTTAP_ENGINE_ENABLED: "0" }, { GRANTTAP_ENGINE_BINARY: "/partial" },
    { GRANTTAP_ENGINE_SHA256: "a".repeat(64) }]) {
    assert.equal(await prepareMonitorEngine({ env, artifact, fetcher }), false);
  }
  saveRuntimeConfig({ enginePath: join(root, "custom-engine"), engineSha256: "a".repeat(64) });
  const env: NodeJS.ProcessEnv = { GRANTTAP_PROJECT_POLICY_ENABLED: "0" };
  assert.equal(await prepareMonitorEngine({ env, artifact, fetcher }), true);
  assert.equal(env.GRANTTAP_ENGINE_BINARY, join(root, "custom-engine"));
  assert.equal(env.GRANTTAP_PROJECT_POLICY_ENABLED, "0");
});

test("installation cannot overwrite a declaration changed while its download was in flight", async t => {
  const root = await fixture(t); const env: NodeJS.ProcessEnv = {};
  const replacement = { enginePath: join(root, "new-custom-engine"), engineSha256: "b".repeat(64) };
  const fetcher: typeof fetch = async () => { saveRuntimeConfig(replacement); return new Response(bytes); };
  await assert.rejects(prepareMonitorEngine({ env, artifact, fetcher }), /declaration changed/);
  assert.equal(loadRuntimeConfig().enginePath, replacement.enginePath);
  assert.equal(env.GRANTTAP_ENGINE_BINARY, undefined);
  assert.equal(await prepareMonitorEngine({ env, artifact, fetcher }), true);
  assert.equal(env.GRANTTAP_ENGINE_BINARY, replacement.enginePath);
});
