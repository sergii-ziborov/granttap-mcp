import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopMeshCreate } from "../../apps/mcp/src/desktop/delivery/mesh-create";
import { readStoreState } from "../../apps/bridge/src/mesh/store/state";

test("New Mesh binds its chosen repository and rejects a duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-new-mesh-"));
  const repository = join(root, "repo");
  execFileSync("git", ["init", "-q", repository]);
  const store = join(root, "project-mesh.json");
  const query = { name: "Shared system", repository_path: repository };
  const first = desktopMeshCreate(query, store, "test-computer");
  assert.equal(first?.created, true);
  assert.equal(readStoreState(store).state.projects[0]?.name, "Shared system");
  assert.equal(readStoreState(store).state.bindings[0]?.projectId, first?.project_id);
  const duplicate = desktopMeshCreate(query, store, "test-computer");
  assert.equal(duplicate?.created, false);
  assert.equal(duplicate?.project_id, first?.project_id);
  assert.equal(readStoreState(store).state.projects.length, 1);
});
