import assert from "node:assert/strict";
import test from "node:test";
import { EngineProtocolError, parseEngineResponse } from
  "../../../apps/bridge/src/engine/protocol/engine-protocol";
import { fitRepositoryGraph } from
  "../../../apps/bridge/src/engine/runtime/repository-graph/fit";
import { ProjectRepositoryGraph } from "../../../packages/protocol/schema";

test("Engine code towers keep repository paths scoped and reject dangling roads", () => {
  const graph = {
    project_id: "p", repository_id: "repo", revision: "sha", weavatrix_version: "2.17.4",
    nodes: [], relations: [], total_nodes: 0, total_relations: 0, truncated: false,
    code_map: {
      files: [{ path: "src/main.ts", language: "typescript", line_count: 42,
        symbols: [{ id: "main", label: "main", kind: "function", start_line: 2, line_count: 10 }] }],
      roads: [], total_files: 1, truncated: false,
    },
  };
  const response = (value: unknown) => ({ protocol_version: 1, request_id: "r",
    status: "ok", result: { operation: "graph.repository", graph: value } });
  assert.equal(parseEngineResponse(response(graph), "r").operation, "graph.repository");
  assert.throws(() => parseEngineResponse(response({ ...graph, code_map: {
    ...graph.code_map,
    roads: [{ source: "src/main.ts", target: "../secret", relation: "imports" }],
  } }), "r"), EngineProtocolError);
  const withExternal = { ...graph, code_map: { ...graph.code_map,
    externals: [{ id: "ext:postgres", label: "Postgres", kind: "service" }],
    total_externals: 1,
    roads: [{ source: "src/main.ts", target: "ext:postgres", relation: "consumes" }],
  } };
  assert.equal(parseEngineResponse(response(withExternal), "r").operation, "graph.repository");
  const projected = ProjectRepositoryGraph.parse({
    projectId: "p", repositoryId: "repo", revision: "sha", weavatrixVersion: "2.17.4",
    nodes: [], relations: [], totalNodes: 0, totalRelations: 0, truncated: false,
    codeMap: {
      files: [{ path: "src/main.ts", language: "typescript", lineCount: 42, symbols: [] }],
      externals: [{ id: "ext:postgres", label: "Postgres", kind: "service" }],
      roads: [{ source: "src/main.ts", target: "ext:postgres", relation: "consumes" }],
      totalFiles: 1, totalExternals: 1, truncated: false,
    },
  });
  assert.equal(projected.codeMap?.roads[0]?.target, "ext:postgres");
  assert.throws(() => parseEngineResponse(response({ ...graph, code_map: {
    ...withExternal.code_map, total_externals: undefined,
  } }), "r"), EngineProtocolError);
  assert.throws(() => parseEngineResponse(response({ ...graph, code_map: {
    ...withExternal.code_map,
    roads: [{ source: "src/main.ts", target: "ext:unknown", relation: "consumes" }],
  } }), "r"), EngineProtocolError);
});

test("wire fitting keeps measured towers and valid roads when a code map is large", () => {
  const files = Array.from({ length: 400 }, (_, index) => ({
    path: `src/module-${index}/file.ts`, language: "typescript", lineCount: index + 1,
    symbols: Array.from({ length: 8 }, (_, symbol) => ({
      id: `symbol-${index}-${symbol}`, label: "observed-symbol-".repeat(4),
      kind: "function", startLine: symbol + 1, lineCount: 3,
    })),
  }));
  const graph = ProjectRepositoryGraph.parse({
    projectId: "p", repositoryId: "repo", revision: "sha", weavatrixVersion: "2.17.4",
    nodes: [], relations: [], totalNodes: 0, totalRelations: 0, truncated: false,
    codeMap: { files, roads: [{ source: files[0]!.path, target: files[1]!.path,
      relation: "imports" }], totalFiles: files.length, truncated: false },
  });
  const fitted = fitRepositoryGraph(graph, 48 * 1_024);
  assert.ok(fitted);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), "utf8") <= 48 * 1_024);
  assert.equal(ProjectRepositoryGraph.safeParse(fitted).success, true);
  assert.equal(fitted.codeMap?.files[0]?.lineCount, 1);
  assert.equal(fitted.codeMap?.truncated, true);
});
