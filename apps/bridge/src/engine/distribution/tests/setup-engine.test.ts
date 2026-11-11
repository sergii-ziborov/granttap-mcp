import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig, saveRuntimeConfig } from "../../../config";
import { projectBackbone, projectRepositoryGraphs } from "../../runtime/engine-projects";
import { EngineSupervisor, type EngineClientLike } from "../../runtime/engine-supervisor";
import { projectRelationshipPeers } from "../../runtime/project-relationships";
import { activateConfiguredEngine } from "../../startup";
import { prepareSetupEngine } from "..";

const ENGINE_ENV = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_ENGINE_BINARY", "GRANTTAP_ENGINE_SHA256",
  "GRANTTAP_ENGINE_ENABLED", "GRANTTAP_PROJECT_POLICY_ENABLED"] as const;
const unavailable: typeof fetch = async () => new Response(null, { status: 404 });

async function fixture(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "granttap-setup-engine-")));
  const previous = Object.fromEntries(ENGINE_ENV.map(name => [name, process.env[name]]));
  for (const name of ENGINE_ENV) delete process.env[name];
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(async () => {
    for (const name of ENGINE_ENV) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function engineAt(path: string, body = "#!/bin/sh\nexit 0\n"): Promise<{ path: string; sha256: string }> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o700);
  return { path, sha256: createHash("sha256").update(body).digest("hex") };
}

test("a computer with no release or an unavailable download completes setup without an Engine", async t => {
  await fixture(t);
  const noRelease = await prepareSetupEngine(undefined, { platform: "linux", arch: "arm64", locations: [] });
  assert.deepEqual(noRelease, { declaration: null,
    reason: "No verified Engine release is available for this computer yet" });
  const missing = await prepareSetupEngine(undefined, { platform: "linux", arch: "x64", fetcher: unavailable, locations: [] });
  assert.deepEqual(missing, { declaration: null, reason: "Verified Engine download is unavailable" });
  const offline = await prepareSetupEngine(undefined, { platform: "darwin", arch: "x64", locations: [],
    fetcher: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(offline.reason, "Engine download could not reach granttap.com");
  assert.equal(loadRuntimeConfig().enginePath, null);
  assert.equal(process.env.GRANTTAP_ENGINE_ENABLED, undefined, "Graph stays off rather than pointing at nothing");
});

test("a failed download keeps the verified Engine this computer already declared", async t => {
  const root = await fixture(t);
  const older = await engineAt(join(root, "config", "engine", "0.1.0-0123456789abcdef", "granttap-engine"));
  saveRuntimeConfig({ enginePath: older.path, engineSha256: older.sha256 });
  const standard = await engineAt(join(root, "bin", "granttap-engine"), "#!/bin/sh\necho other\n");
  const result = await prepareSetupEngine(undefined, { platform: "linux", arch: "x64", fetcher: unavailable,
    locations: [standard.path] });
  assert.deepEqual(result, { declaration: older, reason: "Verified Engine download is unavailable" });
  assert.equal(loadRuntimeConfig().enginePath, older.path);
  assert.equal(process.env.GRANTTAP_ENGINE_BINARY, older.path);
  assert.equal(process.env.GRANTTAP_ENGINE_SHA256, older.sha256);
  assert.equal(process.env.GRANTTAP_ENGINE_ENABLED, "1");
});

test("a changed previous Engine is not trusted again; the standard locations are searched instead", async t => {
  const root = await fixture(t);
  const older = await engineAt(join(root, "config", "engine", "0.1.0-0123456789abcdef", "granttap-engine"));
  saveRuntimeConfig({ enginePath: older.path, engineSha256: older.sha256 });
  await writeFile(older.path, "#!/bin/sh\necho tampered\n");
  const standard = await engineAt(join(root, "bin", "granttap-engine"));
  const result = await prepareSetupEngine(undefined, { platform: "linux", arch: "arm64",
    locations: [join(root, "absent"), standard.path] });
  assert.deepEqual(result.declaration, standard);
  assert.match(result.reason ?? "", /No verified Engine release/);
  assert.equal(loadRuntimeConfig().enginePath, standard.path);
  assert.equal(process.env.GRANTTAP_ENGINE_BINARY, standard.path);
});

test("a configured custom Engine that disappeared and an explicit Engine report their own reasons", async t => {
  const root = await fixture(t);
  saveRuntimeConfig({ enginePath: join(root, "removed-engine"), engineSha256: "a".repeat(64) });
  const standard = await engineAt(join(root, "bin", "granttap-engine"));
  const configured = await prepareSetupEngine(undefined, { locations: [standard.path] });
  assert.equal(configured.reason, "The configured Engine is no longer an executable regular file");
  assert.deepEqual(configured.declaration, standard);
  // An explicitly selected executable is never swapped for another one.
  const explicit = await prepareSetupEngine(join(root, "not-an-engine"), { locations: [standard.path] });
  assert.deepEqual(explicit, { declaration: null, reason: "The selected Engine must be an executable regular file" });
  const ready = await prepareSetupEngine(standard.path, { locations: [] });
  assert.deepEqual(ready, { declaration: standard });
});

test("after setup without an Engine, Graph and Health report it unavailable without any IPC", async t => {
  await fixture(t);
  assert.equal((await prepareSetupEngine(undefined, { platform: "linux", arch: "arm64", locations: [] })).declaration, null);
  const env: NodeJS.ProcessEnv = {};
  activateConfiguredEngine(env);
  assert.deepEqual(env, {}, "no Engine is enabled from an empty declaration");
  let requests = 0;
  const client: EngineClientLike = { request: async () => { requests++; throw new Error("no Engine runs here"); }, close: () => {} };
  const binding = { projectId: "project", bindingId: "binding", endpointId: "computer", repositoryId: "repository",
    displayName: "Repository", available: true };
  assert.equal(await projectBackbone("project", { env, client }), undefined);
  assert.deepEqual(await projectRepositoryGraphs("project", [binding], { env, client }), []);
  assert.deepEqual(await projectRelationshipPeers("project", [binding], { env, client }), []);
  assert.equal((await new EngineSupervisor({ env, client, launch: () => { throw new Error("must not launch"); } })
    .ensureAvailable()).state, "disabled");
  assert.equal(requests, 0);
});
