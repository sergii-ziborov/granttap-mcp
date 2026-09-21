import assert from "node:assert/strict";
import test from "node:test";
import type { MeshSnapshot } from "../../packages/protocol/schema";
import { refreshLocalGraphBindings } from "../../apps/bridge/src/mesh/runtime/graph/binding-sync";

test("Graph refresh readmits only a verified checkout on this endpoint", async () => {
  const project = {
    projectId: "project", name: "Code", canonicalRepositoryId: "repo", createdAt: 1,
  };
  const binding = {
    bindingId: "local", projectId: "project", endpointId: "this-mac",
    repositoryId: "repo", displayName: "Code", localPathHint: "/tmp/code",
    available: true,
  };
  const snapshot = {
    type: "mesh.snapshot", sessionId: "project", projectId: "project", project,
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
    bindings: [binding, { ...binding, bindingId: "remote", endpointId: "other-mac" },
      { ...binding, bindingId: "wrong", repositoryId: "another-repo" }],
  } as MeshSnapshot;
  const admitted: string[] = [];
  await refreshLocalGraphBindings(snapshot, {
    endpoint: () => "this-mac",
    inspect: () => ({ root: "/tmp/code", worktree: "/tmp/code",
      canonicalRepositoryId: "repo", revision: "head" }),
    sync: async (_project, local) => { admitted.push(local.summary.bindingId); return true; },
  });
  assert.deepEqual(admitted, ["local"]);
});
