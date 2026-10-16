import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshSnapshot } from "../../packages/protocol/schema";
import {
  recoverLocalGraphBindings, refreshLocalGraphBindings,
} from "../../apps/bridge/src/mesh/runtime/graph/binding-sync";

test("Graph refresh readmits only a verified checkout on this endpoint", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-graph-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = {
    projectId: "project", name: "Code", canonicalRepositoryId: "repo", createdAt: 1,
  };
  const binding = {
    bindingId: "local", projectId: "project", endpointId: "this-mac",
    repositoryId: "repo", displayName: "Code", localPathHint: root,
    available: true,
  };
  const snapshot = {
    type: "mesh.snapshot", sessionId: "project", projectId: "project", project,
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
    bindings: [binding, { ...binding, bindingId: "remote", endpointId: "other-mac" },
      { ...binding, bindingId: "wrong", repositoryId: "another-repo" }],
  } as MeshSnapshot;
  const admitted: string[] = [];
  const failures = await refreshLocalGraphBindings(snapshot, {
    endpoint: () => "this-mac",
    inspect: () => ({ root, worktree: root,
      canonicalRepositoryId: "repo", revision: "head" }),
    sync: async (_project, local) => { admitted.push(local.summary.bindingId); return true; },
  });
  assert.deepEqual(admitted, ["local"]);
  assert.deepEqual(failures, [], "a stale identity of a checkout another binding already admits is not a failure");
});

test("Mesh Health reports only real repository failures", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-graph-health-"));
  const plain = join(root, "plain"), repo = join(root, "repo"), sub = join(repo, "docs"), moved = join(root, "moved");
  for (const path of [plain, repo, sub, moved]) mkdirSync(path, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = { projectId: "mesh", name: "Mesh", canonicalRepositoryId: "repo", createdAt: 1 };
  const binding = (bindingId: string, path: string, repositoryId: string) => ({ bindingId, projectId: "mesh",
    endpointId: "this-mac", repositoryId, displayName: bindingId, localPathHint: path, available: true });
  const failures = await refreshLocalGraphBindings({
    type: "mesh.snapshot", sessionId: "mesh", projectId: "mesh", project,
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
    bindings: [binding("plain", plain, `local:${plain}`), binding("repo", repo, "repo"),
      binding("sub", sub, `local:${sub}`), binding("gone", join(root, "gone"), "gone"),
      binding("moved", moved, "old-identity"), binding("refused", repo, `local:${repo}`)],
  }, {
    endpoint: () => "this-mac",
    inspect: (path) => {
      if (path.endsWith("gone")) throw new Error("checkout removed");
      if (path === plain) return { root: plain, canonicalRepositoryId: `local:${plain}` };
      if (path === moved) return { root: moved, worktree: moved, canonicalRepositoryId: "new-identity", revision: "h" };
      return { root: repo, worktree: repo, canonicalRepositoryId: "repo", revision: "head" };
    },
    sync: async (_project, local) => local.summary.bindingId !== "refused",
  });
  assert.deepEqual(failures.map((report) => [report.repositoryId, report.analysisErrorCode]), [
    ["old-identity", "REPOSITORY_IDENTITY_MISMATCH"],
    [`local:${repo}`, "ENGINE_ADMISSION_UNAVAILABLE"],
  ], "plain folders, subfolders and removed checkouts are not repositories with a broken graph");
});

test("Engine restart restores existing Git bindings without admitting the workspace root", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-graph-recovery-"));
  const checkout = join(root, "repo");
  mkdirSync(checkout);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const make = (projectId: string, repositoryId: string, path: string): MeshSnapshot => ({
    type: "mesh.snapshot", sessionId: projectId, projectId,
    project: { projectId, name: projectId, canonicalRepositoryId: repositoryId, createdAt: 1 },
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
    bindings: [{ bindingId: path, projectId, endpointId: "this-mac", repositoryId,
      displayName: projectId, localPathHint: path, available: true }],
  });
  const admitted: string[] = [];
  await recoverLocalGraphBindings([
    make("workspace", `local:${root}`, root),
    make("project", "repo", checkout),
  ], {
    endpoint: () => "this-mac",
    inspect: (path) => path === root
      ? { root: path, canonicalRepositoryId: `local:${root}` }
      : { root: path, worktree: path, canonicalRepositoryId: "repo", revision: "head" },
    sync: async (_project, local) => { admitted.push(local.summary.repositoryId); return true; },
  });
  assert.deepEqual(admitted, ["repo"]);
});

test("a removed checkout does not hide another repository in the same Mesh", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-graph-present-"));
  const removed = join(root, "removed");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = { projectId: "mesh", name: "Mesh", canonicalRepositoryId: "repo", createdAt: 1 };
  const binding = (path: string) => ({ bindingId: path, projectId: "mesh",
    endpointId: "this-mac", repositoryId: "repo", displayName: path,
    localPathHint: path, available: true });
  const admitted: string[] = [];
  await refreshLocalGraphBindings({
    type: "mesh.snapshot", sessionId: "mesh", projectId: "mesh", project,
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
    bindings: [binding(removed), binding(root)],
  }, {
    endpoint: () => "this-mac",
    inspect: (path) => {
      if (path === removed) throw new Error("checkout removed");
      return { root: path, worktree: path, canonicalRepositoryId: "repo", revision: "head" };
    },
    sync: async (_project, local) => { admitted.push(local.summary.bindingId); return true; },
  });
  assert.deepEqual(admitted, [root]);
});
