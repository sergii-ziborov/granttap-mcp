import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { MeshSnapshot, ProjectBindingSummary, ProjectRepositoryGraph } from "../../../../../packages/protocol/schema";
import type { RepositoryFacts } from "../../mesh/catalog";
import { analysisOutcome, analyzeCodeFileRepository, type CodeFileAnalysisDependencies } from "../analysis";

const repositoryId = "github.com/me/app";
const graph: ProjectRepositoryGraph = { projectId: "mesh-a", repositoryId, revision: "content-1",
  weavatrixVersion: "2.17.17", analysisStatus: "COMPLETE", nodes: [], relations: [], totalNodes: 0,
  totalRelations: 0, truncated: false };

function checkout(t: test.TestContext): string {
  const root = realpathSync(mkdtempSync("/tmp/granttap-code-file-analysis-"));
  mkdirSync(join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(root: string, overrides: Partial<CodeFileAnalysisDependencies> = {},
  bindings: Partial<ProjectBindingSummary>[] = [{}]) {
  const refreshed: ProjectBindingSummary[] = [];
  const admitted: string[] = [];
  const snapshot = { type: "mesh.snapshot", sessionId: "mesh-a", projectId: "mesh-a",
    project: { projectId: "mesh-a", name: "App", canonicalRepositoryId: repositoryId, createdAt: 1 },
    bindings: bindings.map((binding, index) => ({ projectId: "mesh-a", bindingId: `b${index}`, endpointId: "mac",
      repositoryId, displayName: "App", available: true, localPathHint: root, revision: "recorded", ...binding })),
  } as unknown as MeshSnapshot;
  const facts: RepositoryFacts = { root, worktree: root, revision: "observed", canonicalRepositoryId: repositoryId };
  const deps: CodeFileAnalysisDependencies = {
    snapshot: () => snapshot, endpoint: () => "mac", engineEnabled: () => true,
    prepare: async () => () => ({ ...facts }),
    admit: async current => { admitted.push(...(current.bindings ?? []).map(item => item.repositoryId)); return []; },
    refresh: async (_projectId, binding) => { refreshed.push(binding); return graph; },
    ...overrides,
  };
  return { deps, refreshed, admitted };
}

test("the checkout graph publication analyses is analysed again, at its observed revision", async t => {
  const { deps, refreshed, admitted } = fixture(checkout(t));
  assert.equal(await analyzeCodeFileRepository("mesh-a", repositoryId, deps), "ok");
  assert.deepEqual(admitted, [repositoryId], "the checkout is admitted to the Engine first");
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0]!.revision, "observed", "the same job key as the Mesh publication's build");
});

test("a former alias of a checkout another binding describes is not analysed a second time", async t => {
  const root = checkout(t);
  const { deps, refreshed } = fixture(root, {}, [{}, { repositoryId: `local:${root}`, bindingId: "alias" }]);
  assert.equal(await analyzeCodeFileRepository("mesh-a", `local:${root}`, deps), "not_bound");
  assert.equal(refreshed.length, 0);
  assert.equal(await analyzeCodeFileRepository("mesh-a", repositoryId, deps), "ok");
});

test("a repository not held here, or an Engine that is off, starts no analysis", async t => {
  const root = checkout(t);
  const off = fixture(root, { engineEnabled: () => false });
  assert.equal(await analyzeCodeFileRepository("mesh-a", repositoryId, off.deps), "engine_unavailable");
  assert.equal(await analyzeCodeFileRepository("mesh-a", repositoryId, fixture(root, { snapshot: () => undefined }).deps),
    "not_bound");
  for (const binding of [{ endpointId: "other-mac" }, { available: false }, { localPathHint: undefined }]) {
    const elsewhere = fixture(root, {}, [binding]);
    assert.equal(await analyzeCodeFileRepository("mesh-a", repositoryId, elsewhere.deps), "not_bound");
    assert.equal(elsewhere.refreshed.length, 0);
  }
  const folder = fixture(root, { prepare: async () => () => ({ root, canonicalRepositoryId: `local:${root}` }) });
  assert.equal(await analyzeCodeFileRepository("mesh-a", repositoryId, folder.deps), "not_bound",
    "a folder that is not a Git checkout has no code map");
});

test("a checkout the Engine would not admit says why", async t => {
  const root = checkout(t);
  const failure = (analysisErrorCode: string) => fixture(root, { admit: async () => [{ ...graph,
    analysisStatus: "UNAVAILABLE" as const, analysisErrorCode, revision: "unverified" }] }).deps;
  assert.equal(await analyzeCodeFileRepository("mesh-a", repositoryId, failure("ENGINE_ADMISSION_UNAVAILABLE")),
    "engine_unavailable");
  assert.equal(await analyzeCodeFileRepository("mesh-a", repositoryId, failure("REPOSITORY_IDENTITY_MISMATCH")),
    "not_bound");
});

test("an analysis report says whether the Engine now holds the repository", () => {
  assert.equal(analysisOutcome(undefined), "analysis_failed");
  assert.equal(analysisOutcome(graph), "ok");
  assert.equal(analysisOutcome({ ...graph, analysisStatus: "INCOMPLETE" }), "ok");
  const unavailable = (analysisErrorCode: string) => analysisOutcome({ ...graph, analysisStatus: "UNAVAILABLE",
    analysisErrorCode });
  assert.equal(unavailable("ENGINE_UNAVAILABLE"), "engine_unavailable");
  assert.equal(unavailable("REPOSITORY_NOT_BOUND"), "not_bound");
  assert.equal(unavailable("REPOSITORY_NOT_LOCAL"), "not_bound");
  assert.equal(unavailable("REPOSITORY_IDENTITY_MISMATCH"), "not_bound");
  assert.equal(unavailable("WEAVATRIX_ANALYSIS_PANICKED"), "analysis_failed");
});
