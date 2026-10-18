import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installEngineArtifact, selectEngineArtifact, type EngineArtifact } from "../index";

const bytes = Buffer.from("synthetic Engine executable\n");
const artifact: EngineArtifact = { version: "0.1.1", platform: "linux", arch: "x64",
  sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "granttap-engine-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

test("installation pins the executable bytes, keeps them private and reuses the verified cache", async t => {
  const root = await fixture(t); let requests = 0;
  const fetcher: typeof fetch = async (url, options) => {
    requests++;
    assert.equal(String(url), "https://granttap.com/downloads/engine/0.1.1/granttap-engine-linux-x64");
    assert.equal(options?.redirect, "error");
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  };
  const installed = await installEngineArtifact(artifact, { directory: root, fetcher });
  assert.deepEqual(await readFile(installed.path), bytes);
  assert.equal(installed.sha256, artifact.sha256);
  assert.equal((await lstat(installed.path)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(installed.path, ".."))).mode & 0o777, 0o700);
  assert.deepEqual(await installEngineArtifact(artifact, { directory: root, fetcher }), installed);
  assert.equal(requests, 1);
  await writeFile(installed.path, "tampered cache");
  await installEngineArtifact(artifact, { directory: root, fetcher });
  assert.equal(requests, 2); assert.deepEqual(await readFile(installed.path), bytes);
});

test("corrupted, failed and oversized downloads cannot replace a previous executable", async t => {
  const root = await fixture(t);
  const good = await installEngineArtifact(artifact, { directory: root, fetcher: async () => new Response(bytes) });
  for (const response of [new Response("corrupted bytes"), new Response(null, { status: 503 }),
    new Response(bytes, { headers: { "content-length": "999999999" } })]) {
    const next = { ...artifact, version: "0.1.2" };
    await assert.rejects(installEngineArtifact(next, { directory: root, fetcher: async () => response }));
    assert.deepEqual(await readFile(good.path), bytes);
  }
  await assert.rejects(installEngineArtifact({ ...artifact, version: "0.1.3", bytes: 2 }, { directory: root,
    fetcher: async () => new Response(bytes) }));
});

test("unsafe release metadata and symlinked destinations are refused before any network request", async t => {
  const root = await fixture(t); let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return new Response(bytes); };
  for (const change of [{ version: "../../elsewhere" }, { sha256: "unknown" }, { bytes: 0 },
    { platform: "unknown" }, { arch: "other" }]) {
    await assert.rejects(installEngineArtifact({ ...artifact, ...change } as EngineArtifact, { directory: root, fetcher }));
  }
  const elsewhere = join(root, "elsewhere"); await mkdir(elsewhere);
  await symlink(elsewhere, join(root, "engine"));
  await assert.rejects(installEngineArtifact(artifact, { directory: join(root, "engine"), fetcher }));
  assert.equal(requests, 0);
  assert.equal(selectEngineArtifact("freebsd", "x64"), undefined);
});
