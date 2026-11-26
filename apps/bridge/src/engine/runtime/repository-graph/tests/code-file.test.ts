import assert from "node:assert/strict";
import test from "node:test";
import { EngineRemoteError } from "../../../protocol/transport/protocol-base";
import type { EngineClientLike } from "../../engine-supervisor";
import { codeFileFailure, readEngineCodeFile } from "../code-file";

const env = { GRANTTAP_ENGINE_ENABLED: "1" };
const key = { projectId: "mesh-a", repositoryId: "github.com/me/app", path: "src/api.ts" };
const file = { project_id: key.projectId, repository_id: key.repositoryId, revision: "content-1", analysis_id: null,
  path: key.path, language: "TypeScript", line_count: 12, symbols: [], total_symbols: 0, truncated: false };

function engine(answer: () => unknown): EngineClientLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { calls, close() {}, async request(input, options) {
    calls.push({ input, timeoutMs: options?.timeoutMs });
    const value = answer();
    if (value instanceof Error) throw value;
    return value as never;
  } };
}

test("a file the Engine holds is read from its memory with one bounded request", async () => {
  const client = engine(() => ({ operation: "graph.code_file", file }));
  const read = await readEngineCodeFile(key, { env, client });
  assert.deepEqual(read, { kind: "ok", file });
  assert.deepEqual(client.calls, [{ input: { operation: "graph.code_file",
    input: { project_id: key.projectId, repository_id: key.repositoryId, path: key.path } }, timeoutMs: 10_000 }]);
});

test("each Engine refusal becomes the reason the phone can say", async () => {
  const cases: Array<[unknown, string]> = [
    [new EngineRemoteError("CODE_MAP_NOT_CACHED", "not analysed since start"), "not_cached"],
    [new EngineRemoteError("CODE_FILE_NOT_FOUND", "absent"), "not_found"],
    [new EngineRemoteError("INVALID_OPERATION", "path refused"), "not_found"],
    [new EngineRemoteError("REPOSITORY_NOT_BOUND", "unbound"), "not_bound"],
    [new EngineRemoteError("REPOSITORY_NOT_LOCAL", "elsewhere"), "not_bound"],
    [new EngineRemoteError("INVALID_REQUEST", "an Engine before 0.1.10"), "engine_unavailable"],
    [new EngineRemoteError("WEAVATRIX_ANALYSIS_FAILED", "parser"), "analysis_failed"],
    [new Error("engine request deadline exceeded"), "engine_unavailable"],
    [new Error("connect ENOENT"), "engine_unavailable"],
  ];
  for (const [error, kind] of cases) {
    assert.equal((await readEngineCodeFile(key, { env, client: engine(() => error) })).kind, kind, String(error));
    assert.equal(error instanceof Error && codeFileFailure(error), kind);
  }
});

test("an Engine that is off, an answer for another file and an overlong path are never sections", async () => {
  const client = engine(() => ({ operation: "graph.code_file", file }));
  assert.equal((await readEngineCodeFile(key, { env: {}, client })).kind, "engine_unavailable");
  assert.equal((await readEngineCodeFile({ ...key, path: "é".repeat(300) }, { env, client })).kind, "not_found",
    "600 bytes in 300 characters");
  assert.equal(client.calls.length, 0, "neither reaches the Engine");
  const other = engine(() => ({ operation: "graph.code_file", file: { ...file, path: "src/other.ts" } }));
  assert.equal((await readEngineCodeFile(key, { env, client: other })).kind, "engine_unavailable");
});
