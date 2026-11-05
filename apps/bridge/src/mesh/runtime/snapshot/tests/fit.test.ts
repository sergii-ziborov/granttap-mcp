import assert from "node:assert/strict";
import test from "node:test";
import { fitMeshSnapshot, MESH_SNAPSHOT_BUDGET_BYTES } from "../fit";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function graph(index: number) {
  const nodes = Array.from({ length: 256 }, (_, n) => ({ id: `repo-${index}/src/module-${n}.ts`, kind: "module",
    label: `Module ${n} of repository ${index} with a descriptive label` }));
  const relations = Array.from({ length: 512 }, (_, n) => ({ source: nodes[n % 256]!.id,
    target: nodes[(n * 7 + 1) % 256]!.id, relation: "imports", evidenceCount: n % 9 }));
  return { projectId: "project", repositoryId: `github.com/me/repo-${index}`, revision: "abc", weavatrixVersion: "1",
    analysisStatus: "COMPLETE", nodes, relations, totalNodes: 900, totalRelations: 4_000, truncated: false };
}

test("a project with many bound repositories still fits the relay, keeping the project and marking graphs cut", () => {
  const snapshot = { type: "mesh.snapshot", projectId: "project", project: { projectId: "project", name: "granttap-internal" },
    tasks: [{ taskId: "task-1", title: "Kept" }], repositoryGraphs: Array.from({ length: 13 }, (_, i) => graph(i)),
    repositoryDetails: [{ repositoryId: "github.com/me/repo-0", history: "h".repeat(200_000) }] } as any;
  assert.ok(size(snapshot) > MESH_SNAPSHOT_BUDGET_BYTES, "the fixture starts over the budget");
  const fitted = fitMeshSnapshot(snapshot) as any;
  assert.ok(size(fitted) <= MESH_SNAPSHOT_BUDGET_BYTES);
  assert.deepEqual(fitted.project, snapshot.project);
  assert.deepEqual(fitted.tasks, snapshot.tasks);
  assert.equal(fitted.repositoryGraphs.length, 13, "every repository keeps its graph entry");
  assert.ok(fitted.repositoryGraphs.every((item: any) => item.truncated === true));
});

test("a snapshot already within the budget is sent unchanged", () => {
  const small = { type: "mesh.snapshot", projectId: "p", repositoryGraphs: [graph(0)] } as any;
  assert.equal(fitMeshSnapshot(small), small);
  const hopeless = { type: "mesh.snapshot", projectId: "p", tasks: ["t".repeat(MESH_SNAPSHOT_BUDGET_BYTES)],
    repositoryGraphs: [graph(1)], repositoryDetails: [{ history: "h" }] } as any;
  const reduced = fitMeshSnapshot(hopeless) as any;
  assert.equal(reduced.repositoryGraphs, undefined, "graphs and details go before the project itself would");
  assert.equal(reduced.repositoryDetails, undefined);
});
