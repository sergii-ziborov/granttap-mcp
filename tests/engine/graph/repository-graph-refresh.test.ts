import assert from "node:assert/strict";
import test from "node:test";
import { projectRepositoryGraphs } from "../../../apps/bridge/src/engine/runtime/engine-projects";
import type { EngineClientLike } from "../../../apps/bridge/src/engine/runtime/engine-supervisor";

test("explicit graph refresh replaces the background result retained by later snapshots", async () => {
  let nodes = 1;
  const client: EngineClientLike = { close() {}, async request(input) {
    if (input.operation !== "graph.analyze_repository") throw new Error("unexpected operation");
    return { operation: "graph.repository", graph: {
      project_id: input.input.project_id, repository_id: input.input.repository_id,
      revision: "sha", weavatrix_version: "2.17.4", analysis_status: "COMPLETE",
      nodes: [], relations: [], total_nodes: nodes, total_relations: 0, truncated: false,
    } };
  } };
  const bindings = [{ projectId: "refresh-cache", bindingId: "b", endpointId: "mac",
    repositoryId: "repo", displayName: "Repo", available: true }];
  const options = { client, env: { GRANTTAP_ENGINE_ENABLED: "1" } };
  await projectRepositoryGraphs("refresh-cache", bindings, { ...options, background: true });
  await new Promise((resolve) => setImmediate(resolve));
  nodes = 4;
  assert.equal((await projectRepositoryGraphs("refresh-cache", bindings, options))[0]?.totalNodes, 4);
  assert.equal((await projectRepositoryGraphs("refresh-cache", bindings,
    { ...options, background: true }))[0]?.totalNodes, 4);
});
