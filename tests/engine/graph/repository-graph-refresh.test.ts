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

test("an explicit build joins its running automatic analysis instead of scanning twice", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let analyses = 0;
  const client: EngineClientLike = { close() {}, async request(input) {
    if (input.operation !== "graph.analyze_repository") throw new Error("unexpected operation");
    analyses++;
    await held;
    return { operation: "graph.repository", graph: {
      project_id: input.input.project_id, repository_id: input.input.repository_id,
      revision: "sha", weavatrix_version: "2.17.4", analysis_status: "COMPLETE",
      nodes: [], relations: [], total_nodes: 4, total_relations: 0, truncated: false,
    } };
  } };
  const bindings = [{ projectId: "coalesced-build", bindingId: "b", endpointId: "mac",
    repositoryId: "repo", displayName: "Repo", available: true, revision: "sha" }];
  const options = { client, env: { GRANTTAP_ENGINE_ENABLED: "1" } };
  await projectRepositoryGraphs("coalesced-build", bindings, { ...options, background: true });
  const explicit = projectRepositoryGraphs("coalesced-build", bindings, options);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(analyses, 1, "The same repository revision must have one analysis in flight.");
  } finally { release(); await explicit; }
  const reports = await projectRepositoryGraphs("coalesced-build", bindings,
    { ...options, background: true });
  assert.equal(reports[0]?.totalNodes, 4);
});

test("the content fingerprint retains the admitted Git revision as separate provenance", async () => {
  const client: EngineClientLike = { close() {}, async request(input) {
    if (input.operation !== "graph.analyze_repository") throw new Error("unexpected operation");
    return { operation: "graph.repository", graph: {
      project_id: input.input.project_id, repository_id: input.input.repository_id,
      revision: "content-fingerprint", weavatrix_version: "2.17.4", analysis_status: "COMPLETE",
      nodes: [], relations: [], total_nodes: 1, total_relations: 0, truncated: false,
    } };
  } };
  const binding = { projectId: "provenance-build", bindingId: "b", endpointId: "mac",
    repositoryId: "repo", displayName: "Repo", available: true, revision: "git-head" };
  const reports = await projectRepositoryGraphs(binding.projectId, [binding],
    { client, env: { GRANTTAP_ENGINE_ENABLED: "1" } });
  assert.equal(reports[0]?.revision, "content-fingerprint");
  assert.equal(reports[0]?.sourceRevision, "git-head");
});
