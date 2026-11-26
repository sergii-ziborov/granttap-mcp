import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CODE_FILE_RESULT_BYTES, MAX_CODE_FILE_SYMBOLS, Payload, ProjectCodeFileQuery, ProjectCodeFileResult,
} from "../../../../schema";
import { ProjectCodeMap } from "../code-map";

const at = 1_800_000_000_000;
const query = { type: "project.code_file.query", projectId: "mesh-a", repositoryId: "github.com/me/app",
  path: "apps/bridge/src/approvals/api.ts", requestId: "code-1", createdAt: at };
const section = (index: number) => ({ id: `apps/bridge/src/approvals/api.ts#fn-${index}`, label: `export${index}`,
  kind: "function", startLine: index + 1, lineCount: 3,
  metrics: { measured: true, sourceLines: 3, cyclomatic: 1, maxLoopDepth: 0, callers: 2 } });
const ok = { type: "project.code_file.result", projectId: "mesh-a", repositoryId: "github.com/me/app",
  path: "apps/bridge/src/approvals/api.ts", requestId: "code-1", status: "ok", revision: "rev-1",
  analysisId: "analysis-1", language: "TypeScript", lineCount: 120,
  symbols: [section(0), { ...section(1), metrics: undefined }], totalSymbols: 11, truncated: true, createdAt: at };

test("a code file query and its answer travel in the encrypted protocol", () => {
  assert.equal(Payload.parse(query).type, "project.code_file.query");
  assert.equal(Payload.parse(ok).type, "project.code_file.result");
  for (const status of ["analyzing", "not_found", "not_bound", "engine_unavailable", "analysis_failed"]) {
    const answer = { ...ok, status, symbols: [], totalSymbols: 0, truncated: false, revision: undefined,
      analysisId: undefined, language: undefined, lineCount: undefined };
    assert.equal(Payload.safeParse(answer).success, true, status);
  }
});

test("a query names one repository-relative file and nothing else", () => {
  assert.equal(ProjectCodeFileQuery.safeParse({ ...query, extra: true }).success, false, "strict");
  for (const path of ["", "/etc/passwd", "apps/../../secret", "a".repeat(513)]) {
    assert.equal(ProjectCodeFileQuery.safeParse({ ...query, path }).success, false, path);
  }
  assert.equal(ProjectCodeFileQuery.safeParse({ ...query, projectId: "p".repeat(129) }).success, false);
  assert.equal(ProjectCodeFileQuery.safeParse({ ...query, repositoryId: "" }).success, false);
  assert.equal(ProjectCodeFileQuery.safeParse({ ...query, repositoryId: "r".repeat(513) }).success, false);
  assert.equal(ProjectCodeFileQuery.safeParse({ ...query, requestId: "" }).success, false);
  assert.equal(ProjectCodeFileQuery.safeParse({ ...query, requestId: "r".repeat(129) }).success, false);
  assert.equal(ProjectCodeFileQuery.safeParse({ ...query, createdAt: Number.NaN }).success, false);
  assert.equal(ProjectCodeFileQuery.safeParse({ ...query, createdAt: undefined }).success, false);
});

test("an answer's sections are exactly the code map's section objects", () => {
  const mapFile = { path: ok.path, language: "TypeScript", lineCount: 120, symbols: ok.symbols };
  assert.equal(ProjectCodeMap.safeParse({ files: [mapFile], roads: [], totalFiles: 1, truncated: false }).success, true);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, symbols: [{ ...section(0), extra: 1 }] }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, symbols: [{ ...section(0), startLine: 0 }] }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok,
    symbols: [{ ...section(0), metrics: { ...section(0).metrics, measured: false } }] }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, symbols: [{ ...section(0), label: "l".repeat(161) }] }).success,
    false);
});

test("an answer refuses what the contract leaves out", () => {
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, extra: true }).success, false, "strict");
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, status: "busy" }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, status: "analyzing" }).success, false,
    "only ok carries sections");
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, totalSymbols: 1 }).success, false, "total below the list");
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, totalSymbols: -1 }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, lineCount: 0 }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, revision: "r".repeat(513) }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, analysisId: "a".repeat(129) }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, language: "l".repeat(65) }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, symbols: undefined }).success, false);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, truncated: undefined }).success, false);
});

test("an answer holds at most 2,000 sections and 160 KiB", () => {
  const many = Array.from({ length: MAX_CODE_FILE_SYMBOLS + 1 }, (_, index) => ({ ...section(index), metrics: undefined }));
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, symbols: many, totalSymbols: many.length }).success, false);
  const fits = many.slice(0, 400);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, symbols: fits, totalSymbols: 2_001 }).success, true);
  const wide = Array.from({ length: 400 }, (_, index) => ({ ...section(index), id: `${"x".repeat(500)}${index}` }));
  assert.ok(Buffer.byteLength(JSON.stringify({ ...ok, symbols: wide })) > MAX_CODE_FILE_RESULT_BYTES);
  assert.equal(ProjectCodeFileResult.safeParse({ ...ok, symbols: wide, totalSymbols: 400 }).success, false);
});
