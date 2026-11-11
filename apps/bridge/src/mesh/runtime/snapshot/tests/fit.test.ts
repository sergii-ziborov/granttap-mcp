import assert from "node:assert/strict";
import test from "node:test";
import { fitMeshSnapshot, MESH_SNAPSHOT_BUDGET_BYTES } from "../fit";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
/** `ProjectMeshWireValidator.validSnapshot` on every iPhone build drops a larger plaintext snapshot. */
const PHONE_ENVELOPE_BYTES = 256 * 1_024;

function graph(index: number) {
  const nodes = Array.from({ length: 256 }, (_, n) => ({ id: `repo-${index}/src/module-${n}.ts`, kind: "module",
    label: `Module ${n} of repository ${index} with a descriptive label` }));
  const relations = Array.from({ length: 512 }, (_, n) => ({ source: nodes[n % 256]!.id,
    target: nodes[(n * 7 + 1) % 256]!.id, relation: "imports", evidenceCount: n % 9 }));
  return { projectId: "project", repositoryId: `github.com/me/repo-${index}`, revision: "abc", weavatrixVersion: "1",
    analysisStatus: "COMPLETE", nodes, relations, totalNodes: 900, totalRelations: 4_000, truncated: false };
}

/** A Project people work in: its Tasks, their chats and recent Mesh events, with a Graph reply on top. */
function busyProject(events: number, eventBytes: number, repositories: number) {
  const tasks = Array.from({ length: 64 }, (_, n) => ({ taskId: `task-${n}`, projectId: "project",
    title: `Task ${n} `.repeat(12), summary: "s".repeat(400) }));
  return { type: "mesh.snapshot", sessionId: "project", projectId: "project", graphAnalysisRequestId: "build-1",
    project: { projectId: "project", name: "granttap-internal" }, tasks,
    executions: Array.from({ length: 128 }, (_, n) => ({ id: `execution-${n}`, taskId: `task-${n % 64}`,
      provider: "claude", sessionId: `session-${n}`.padEnd(36, "0"), computerId: "mac", workspace: "/dev/nodvox" })),
    events: Array.from({ length: events }, (_, n) => ({ eventId: `event-${n}`, projectId: "project",
      taskId: `task-${n % 64}`, eventType: "HANDOFF_REQUEST", createdAt: n, payload: { summary: "e".repeat(eventBytes) } })),
    repositoryGraphs: Array.from({ length: repositories }, (_, i) => graph(i)),
    repositoryDetails: [{ repositoryId: "github.com/me/repo-0", commits: [] }] } as any;
}

test("a requested Graph for a busy Project reaches the phone with evidence for every repository", () => {
  const reply = busyProject(40, 900, 3);
  assert.ok(size(reply) > PHONE_ENVELOPE_BYTES, "the reply starts over the phone's envelope");
  const fitted = fitMeshSnapshot(reply) as any;
  assert.ok(size(fitted) <= PHONE_ENVELOPE_BYTES, `${size(fitted)} bytes would be dropped by the phone`);
  assert.equal(fitted.graphAnalysisRequestId, "build-1", "the phone settles the build with this receipt");
  assert.deepEqual(fitted.tasks, reply.tasks);
  assert.deepEqual(fitted.events, reply.events, "the Graph made room without leaving events out");
  assert.equal(fitted.repositoryGraphs.length, 3);
  assert.ok(fitted.repositoryGraphs.every((item: any) => item.nodes.length > 0 && item.truncated === true));
});

test("older events and executions are left to earlier snapshots before a Graph loses its evidence", () => {
  const reply = busyProject(128, 1_800, 2);
  const fitted = fitMeshSnapshot(reply) as any;
  assert.ok(size(fitted) <= PHONE_ENVELOPE_BYTES, `${size(fitted)} bytes would be dropped by the phone`);
  assert.deepEqual(fitted.tasks, reply.tasks, "Tasks are never cut");
  assert.ok(fitted.events.length < reply.events.length);
  assert.deepEqual(fitted.events, reply.events.slice(-fitted.events.length), "the newest events stay");
  assert.ok(size(fitted.repositoryGraphs) >= 72 * 1_024, "the Graph keeps its share of the envelope");
  assert.ok(fitted.repositoryGraphs.every((item: any) => item.nodes.length > 0));
});

test("a project with many bound repositories still fits, keeping the project and marking graphs cut", () => {
  const snapshot = { type: "mesh.snapshot", projectId: "project", project: { projectId: "project", name: "granttap-internal" },
    tasks: [{ taskId: "task-1", title: "Kept" }], repositoryGraphs: Array.from({ length: 13 }, (_, i) => graph(i)),
    repositoryDetails: [{ repositoryId: "github.com/me/repo-0", history: "h".repeat(200_000) }] } as any;
  assert.ok(size(snapshot) > MESH_SNAPSHOT_BUDGET_BYTES, "the fixture starts over the budget");
  const fitted = fitMeshSnapshot(snapshot) as any;
  assert.ok(size(fitted) <= PHONE_ENVELOPE_BYTES);
  assert.deepEqual(fitted.project, snapshot.project);
  assert.deepEqual(fitted.tasks, snapshot.tasks);
  assert.equal(fitted.repositoryGraphs.length, 13, "every repository keeps its graph entry");
  assert.ok(fitted.repositoryGraphs.every((item: any) => item.truncated === true));
});

test("a snapshot already within the budget is sent unchanged", () => {
  const small = { type: "mesh.snapshot", projectId: "p", repositoryGraphs: [graph(0)] } as any;
  assert.equal(fitMeshSnapshot(small), small);
});

test("a reply that cannot fit still names its repositories, so a requested build is answered", () => {
  const hopeless = { type: "mesh.snapshot", projectId: "p", tasks: ["t".repeat(PHONE_ENVELOPE_BYTES)],
    executions: [], events: [], repositoryGraphs: [graph(1)], repositoryDetails: [{ history: "h" }] } as any;
  const reduced = fitMeshSnapshot(hopeless) as any;
  assert.deepEqual(reduced.tasks, hopeless.tasks, "the project itself is never cut");
  assert.equal(reduced.repositoryDetails, undefined);
  assert.equal(reduced.repositoryGraphs.length, 1, "the phone's build waits for a graph entry");
  assert.deepEqual([reduced.repositoryGraphs[0].repositoryId, reduced.repositoryGraphs[0].nodes.length,
    reduced.repositoryGraphs[0].truncated], ["github.com/me/repo-1", 0, true]);
});
