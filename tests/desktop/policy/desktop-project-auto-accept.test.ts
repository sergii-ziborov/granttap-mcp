import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopProjectAutoAccept } from "../../../apps/mcp/src/desktop/policy/auto-accept";
import { loadRuntimeConfig } from "../../../apps/bridge/src/config/runtime";

test("Mac auto-accept edits only the selected persisted Mesh and reads confirmed state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "desktop-auto-accept-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const store = join(root, "mesh.json");
  await writeFile(store, JSON.stringify({ version: 1,
    projects: [{ projectId: "mesh", canonicalRepositoryId: "repo", name: "Mesh", createdAt: 1 }],
    bindings: [{ bindingId: "b", projectId: "mesh", repositoryId: "repo", endpointId: "mac",
      displayName: "repo", available: true }],
  }));
  const options = { storePath: store, endpointId: "mac" };
  const globalDefault = loadRuntimeConfig().autoAcceptDefault;
  assert.equal(desktopProjectAutoAccept({ project_id: "mesh" }, options)?.level, globalDefault);
  assert.equal(desktopProjectAutoAccept({ project_id: "mesh", level: "safe" }, options)?.level, "safe");
  assert.equal(loadRuntimeConfig().autoAcceptByProject.mesh, "safe");
  assert.equal(loadRuntimeConfig().autoAcceptDefault, globalDefault);
  assert.equal(desktopProjectAutoAccept({ project_id: "other", level: "full" }, options), undefined);
  assert.equal(desktopProjectAutoAccept({ project_id: "mesh", level: "bad" }, options), undefined);
  assert.equal(desktopProjectAutoAccept({ project_id: "mesh", level: "full" },
    { ...options, endpointId: "other" }), undefined);
  assert.equal(loadRuntimeConfig().autoAcceptByProject.mesh, "safe");
});
