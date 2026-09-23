import assert from "node:assert/strict";
import test from "node:test";
import type { MeshSnapshot } from "../../packages/protocol/schema";
import {
  recoverLocalGraphBindings, refreshLocalGraphBindings,
} from "../../apps/bridge/src/mesh/runtime/graph/binding-sync";

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

test("Engine restart restores existing Git bindings without admitting the workspace root", async () => {
  const make = (projectId: string, repositoryId: string, path: string): MeshSnapshot => ({
    type: "mesh.snapshot", sessionId: projectId, projectId,
    project: { projectId, name: projectId, canonicalRepositoryId: repositoryId, createdAt: 1 },
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
    bindings: [{ bindingId: path, projectId, endpointId: "this-mac", repositoryId,
      displayName: projectId, localPathHint: path, available: true }],
  });
  const admitted: string[] = [];
  await recoverLocalGraphBindings([
    make("workspace", "local:/tmp/dev", "/tmp/dev"),
    make("project", "repo", "/tmp/dev/repo"),
  ], {
    endpoint: () => "this-mac",
    inspect: (path) => path === "/tmp/dev"
      ? { root: path, canonicalRepositoryId: "local:/tmp/dev" }
      : { root: path, worktree: path, canonicalRepositoryId: "repo", revision: "head" },
    sync: async (_project, local) => { admitted.push(local.summary.repositoryId); return true; },
  });
  assert.deepEqual(admitted, ["repo"]);
});

test("a removed checkout does not hide another repository in the same Mesh", async () => {
  const project = { projectId: "mesh", name: "Mesh", canonicalRepositoryId: "repo", createdAt: 1 };
  const binding = (path: string) => ({ bindingId: path, projectId: "mesh",
    endpointId: "this-mac", repositoryId: "repo", displayName: path,
    localPathHint: path, available: true });
  const admitted: string[] = [];
  await refreshLocalGraphBindings({
    type: "mesh.snapshot", sessionId: "mesh", projectId: "mesh", project,
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
    bindings: [binding("/removed"), binding("/present")],
  }, {
    endpoint: () => "this-mac",
    inspect: (path) => {
      if (path === "/removed") throw new Error("checkout removed");
      return { root: path, worktree: path, canonicalRepositoryId: "repo", revision: "head" };
    },
    sync: async (_project, local) => { admitted.push(local.summary.bindingId); return true; },
  });
  assert.deepEqual(admitted, ["/present"]);
});
