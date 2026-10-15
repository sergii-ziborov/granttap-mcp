import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshLocalGraphBindings } from "../binding-sync";
import { inspectRepository } from "../../../catalog";
import { graphAnalysisBindings, matchesLocalCheckout } from "../checkout-identity";
import type { MeshSnapshot } from "../../../../../../../packages/protocol/schema";

test("a path-scoped checkout still builds after Git discovers its origin", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-local-graph-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/example/project.git"]);
  writeFileSync(join(root, "entry.ts"), "export const graph = 1;\n");
  const binding = { bindingId: "local", projectId: "mesh", endpointId: "mac",
    repositoryId: `local:${root}`, localPathHint: root, displayName: "Project", available: true };
  const snapshot = { projectId: "mesh", project: { projectId: "mesh", name: "Mesh",
    canonicalRepositoryId: "github.com/example/workspace", createdAt: 1 }, bindings: [binding] } as MeshSnapshot;
  const admitted: { id: string; remote?: string }[] = [];
  const dependencies = { endpoint: () => "mac", inspect: inspectRepository,
    sync: async (_project: unknown, local: { summary: { repositoryId: string }; canonicalRemote?: string }) => {
      admitted.push({ id: local.summary.repositoryId, remote: local.canonicalRemote });
      return true;
    } };
  assert.deepEqual(await refreshLocalGraphBindings(snapshot, dependencies), []);
  assert.deepEqual(admitted, [{ id: `local:${root}`, remote: undefined }],
    "A path identity remains path-scoped; origin observations do not change Mesh membership.");
  const wrongPath = { ...snapshot, bindings: [{ ...binding, repositoryId: `local:${root}-other` }] };
  assert.equal((await refreshLocalGraphBindings(wrongPath, dependencies))[0]?.analysisErrorCode,
    "REPOSITORY_IDENTITY_MISMATCH");
  const wrongRemote = { ...snapshot, bindings: [{ ...binding, repositoryId: "github.com/example/other" }] };
  assert.equal((await refreshLocalGraphBindings(wrongRemote, dependencies))[0]?.analysisErrorCode,
    "REPOSITORY_IDENTITY_MISMATCH");
});

test("graph checkout selection prefers its admitted canonical identity and retains other computers", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-graph-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = { bindingId: "local", projectId: "mesh", endpointId: "mac",
    repositoryId: `local:${root}`, localPathHint: root, displayName: "Project", available: true };
  const canonical = { ...local, bindingId: "canonical", repositoryId: "github.com/example/project" };
  const remote = { ...canonical, bindingId: "other-computer", endpointId: "other" };
  const removed = { ...local, bindingId: "removed", localPathHint: `${root}/removed`, repositoryId: "removed" };
  const offline = { ...local, bindingId: "offline", available: false, repositoryId: "offline" };
  const pathless = { ...local, bindingId: "pathless", localPathHint: undefined, repositoryId: "pathless" };
  assert.deepEqual(graphAnalysisBindings([local, canonical, remote, removed, offline, pathless]).map(b => b.bindingId),
    ["canonical", "other-computer", "removed", "offline", "pathless"]);
  assert.deepEqual(graphAnalysisBindings([canonical, local]).map(b => b.bindingId), ["canonical"]);
  assert.equal(matchesLocalCheckout(`local:${root}/removed`, root), false);
  assert.equal(matchesLocalCheckout("local:relative-directory", root), false);
  assert.equal(matchesLocalCheckout("github.com/example/project", root), false);
});
