import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { graphAnalysisBindings } from "../checkout-identity";
import { refreshLocalGraphBindings } from "../binding-sync";
import { inspectRepository } from "../../../catalog";
import type { MeshSnapshot } from "../../../../../../../packages/protocol/schema";

function checkout(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "granttap-graph-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "sergii-ziborov",
      GIT_AUTHOR_EMAIL: "sergii.ziborov@gmail.com", GIT_COMMITTER_NAME: "sergii-ziborov",
      GIT_COMMITTER_EMAIL: "sergii.ziborov@gmail.com" },
  }).trim();
  git("init", "--quiet");
  git("remote", "add", "origin", "https://github.com/example/portable-project.git");
  writeFileSync(join(root, "entry.ts"), "export const value = 1;\n");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture");
  const revision = git("rev-parse", "HEAD");
  const binding = { bindingId: "current", projectId: "mesh", endpointId: "computer",
    repositoryId: "github.com/example/portable-project", localPathHint: root,
    displayName: "Portable project", revision: "outdated-observation", available: true };
  return { root, revision, binding };
}

test("a retired non-path identity cannot displace the verified checkout during graph selection", t => {
  const { binding, revision } = checkout(t);
  const retired = { ...binding, bindingId: "retired", repositoryId: "retired-identity" };
  const selected = graphAnalysisBindings([retired, binding]);
  assert.deepEqual(selected.map(row => row.repositoryId), [binding.repositoryId]);
  assert.equal(selected[0]?.revision, revision, "Graph provenance names the observed Git commit");
  assert.equal(binding.revision, "outdated-observation", "Selection does not mutate its catalog input");
});

test("repository admission carries the observed commit instead of an old catalog revision", async t => {
  const { binding, revision } = checkout(t);
  const snapshot = { projectId: "mesh", project: { projectId: "mesh", name: "Mesh",
    canonicalRepositoryId: binding.repositoryId, createdAt: 1 }, bindings: [binding] } as MeshSnapshot;
  const admitted: string[] = [];
  const failures = await refreshLocalGraphBindings(snapshot, {
    endpoint: () => "computer", inspect: inspectRepository,
    sync: async (_project, local) => { admitted.push(local.summary.revision ?? ""); return true; },
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(admitted, [revision]);
});

test("a computer only analyzes bindings owned by its endpoint, even when a foreign path exists locally", t => {
  const { binding } = checkout(t);
  const foreign = { ...binding, bindingId: "foreign", endpointId: "another-computer" };
  assert.deepEqual(graphAnalysisBindings([foreign, binding], "computer").map(row => row.bindingId), ["current"]);
});

test("a historical subfolder revision is not a repository with a failed graph", t => {
  const { binding, root } = checkout(t);
  const folder = join(root, "scratch"); mkdirSync(folder);
  const nested = { ...binding, bindingId: "scratch", repositoryId: `local:${folder}`, localPathHint: folder };
  assert.deepEqual(graphAnalysisBindings([nested, binding]).map(row => row.bindingId), ["current"]);
});
