import assert from "node:assert/strict";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  declarationFor,
  declareEngine,
  defaultEngineLocations,
  usableEngineBinary,
} from "../apps/bridge/src/engine/engine-declaration";
import { loadRuntimeConfig } from "../apps/bridge/src/config";

async function sandbox(t: { after: (fn: () => void) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-engine-declaration-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  return root;
}

async function engineAt(root: string, name = "granttap-engine"): Promise<string> {
  const path = join(root, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

test("declaring an engine writes the path and its checksum", async (t) => {
  const root = await sandbox(t);
  const path = await engineAt(root);

  const declaration = declareEngine(path);
  assert.equal(declaration?.path, path);
  assert.match(declaration?.sha256 ?? "", /^[a-f\d]{64}$/);

  // The declaration is what the LaunchAgent later reads, so it must persist.
  const stored = loadRuntimeConfig();
  assert.equal(stored.enginePath, path);
  assert.equal(stored.engineSha256, declaration?.sha256);
});

test("nothing usable declares nothing rather than a broken rollout", async (t) => {
  const root = await sandbox(t);
  assert.equal(declareEngine(join(root, "absent")), null);
  assert.equal(loadRuntimeConfig().enginePath, null);

  // A relative path can never be verified, so it is refused outright.
  assert.equal(usableEngineBinary("granttap-engine"), false);

  // A file that is not executable is not an engine.
  const plain = join(root, "not-executable");
  await writeFile(plain, "text");
  assert.equal(declarationFor(plain), null);

  // A symlink is refused: the checksum would describe a different file.
  const target = await engineAt(root, "real-engine");
  const link = join(root, "linked-engine");
  await symlink(target, link);
  assert.equal(usableEngineBinary(link), false);
});

test("the standard locations are searched when no path is given", async (t) => {
  const root = await sandbox(t);
  const locations = defaultEngineLocations(root);
  // The config directory comes first: that is where an install would place it.
  assert.match(locations[0]!, /engine\/granttap-engine$/);
  assert.ok(locations.length >= 3, "a single location is not a search");
  assert.ok(locations.every((path) => path.startsWith("/")), "all absolute");
});
