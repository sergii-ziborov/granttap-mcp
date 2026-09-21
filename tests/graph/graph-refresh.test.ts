import assert from "node:assert/strict";
import test from "node:test";
import type { MeshSnapshot } from "../../packages/protocol/schema";
import { requestProjectGraphRefresh } from "../../apps/bridge/src/monitor/graph-refresh";
import { analyzeProjectGraphNow } from "../../apps/bridge/src/mesh/runtime";

test("Graph refresh coalesces one Project without blocking another", async () => {
  const requests: string[] = [];
  let finish: (value: boolean) => void = () => undefined;
  const pending = new Promise<boolean>((resolve) => { finish = resolve; });
  const analyze = async (_client: unknown, projectId: string) => {
    requests.push(projectId);
    return projectId === "first" ? pending : true;
  };
  assert.equal(requestProjectGraphRefresh({} as never, "first", analyze), true);
  assert.equal(requestProjectGraphRefresh({} as never, "first", analyze), false);
  assert.equal(requestProjectGraphRefresh({} as never, "second", analyze), true);
  assert.deepEqual(requests, ["first", "second"]);
  finish(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestProjectGraphRefresh({} as never, "first", analyze), true);
  finish(true);
});

test("explicit Graph build refreshes one admitted Project and reports missing bindings", async () => {
  const snapshot: MeshSnapshot = {
    type: "mesh.snapshot", sessionId: "project", projectId: "project",
    project: { projectId: "project", name: "Repository", canonicalRepositoryId: "repo", createdAt: 1 },
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
  };
  const sent: MeshSnapshot[] = [];
  const calls: string[] = [];
  const dependencies = {
    snapshots: () => [snapshot],
    wait: async (projectId: string) => { calls.push(`wait:${projectId}`); },
    backbone: async (projectId: string) => {
      calls.push(`backbone:${projectId}`);
      return undefined;
    },
    graphs: async (projectId: string, bindings: NonNullable<MeshSnapshot["bindings"]>,
      options?: { background?: boolean }) => {
      calls.push(`graphs:${projectId}:${bindings.length}:${options?.background}`);
      return [];
    },
    send: async (_client: unknown, value: MeshSnapshot) => { sent.push(value); },
  };
  assert.equal(await analyzeProjectGraphNow({} as never, "other", dependencies), false);
  assert.equal(await analyzeProjectGraphNow({} as never, "project", dependencies), true);
  assert.deepEqual(calls, ["wait:project", "backbone:project", "graphs:project:0:false"]);
  assert.equal(sent[0]?.projectId, "project");
  assert.equal(sent[0]?.repositoryGraphs?.[0]?.analysisErrorCode, "REPOSITORY_NOT_BOUND");
  assert.equal(sent[0]?.repositoryGraphs?.[0]?.analysisStatus, "UNAVAILABLE");
  assert.ok((sent[0]?.generatedAt ?? 0) > snapshot.generatedAt);
});
