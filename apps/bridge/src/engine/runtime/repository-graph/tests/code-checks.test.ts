import assert from "node:assert/strict";
import test from "node:test";
import { projectRepositoryGraphs } from "../../engine-projects";
import { parseEngineResponse } from "../../../protocol/engine-protocol";
import type { EngineClientLike } from "../../engine-supervisor";
import { ProjectRepositoryGraph } from "../../../../../../../packages/protocol/schema";

const metrics = { measured: true, source_lines: 12, cyclomatic: 4, max_loop_depth: 2, callers: 0 };
const graph = { project_id: "checks", repository_id: "repo", revision: "fingerprint",
  weavatrix_version: "2.17.4", analysis_status: "COMPLETE" as const,
  nodes: [], relations: [], total_nodes: 0, total_relations: 0, truncated: false,
  code_map: { files: [{ path: "main.rs", language: "rust", line_count: 12,
    symbols: [{ id: "f", label: "f", kind: "function", start_line: 1, line_count: 12, metrics }] }],
  roads: [], total_files: 1, truncated: false } };

test("real Engine code checks survive projection, wire validation and bounded fitting", async () => {
  const client: EngineClientLike = { close() {}, async request() { return { operation: "graph.repository", graph }; } };
  const reports = await projectRepositoryGraphs("checks", [{ bindingId: "b", projectId: "checks", endpointId: "vm",
    repositoryId: "repo", displayName: "Repo", available: true, revision: "git-head" }],
  { client, env: { GRANTTAP_ENGINE_ENABLED: "1" } });
  const parsed = ProjectRepositoryGraph.parse(reports[0]);
  assert.deepEqual(parsed.codeMap?.files[0]?.symbols[0]?.metrics,
    { measured: true, sourceLines: 12, cyclomatic: 4, maxLoopDepth: 2, callers: 0 });
});

test("malformed Engine checks are rejected rather than displayed as healthy", () => {
  const invalid = structuredClone(graph); invalid.code_map.files[0]!.symbols[0]!.metrics.cyclomatic = -1;
  assert.throws(() => parseEngineResponse({ protocol_version: 1, request_id: "checks", status: "ok",
    result: { operation: "graph.repository", graph: invalid } }, "checks"));
});
