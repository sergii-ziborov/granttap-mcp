import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CODE_FILE_RESULT_BYTES, MAX_CODE_FILE_SYMBOLS, Payload } from "../../../../../packages/protocol/schema";
import type { EngineCodeFile, EngineCodeSymbol } from "../../engine/protocol/code-file";
import { codeFileResult } from "../wire";

const query = { projectId: "mesh-a", repositoryId: "github.com/me/app", path: "apps/bridge/src/approvals/api.ts",
  requestId: "code-1" };
const symbol = (index: number, id = `${query.path}#export-${index}`): EngineCodeSymbol => ({ id,
  label: `export${index}`, kind: "function", start_line: index * 10 + 1, line_count: 9,
  ...(index % 2 ? {} : { metrics: { measured: true, source_lines: 9, cyclomatic: 2, max_loop_depth: 1, callers: index } }) });
const file = (symbols: EngineCodeSymbol[], extra: Partial<EngineCodeFile> = {}): EngineCodeFile => ({
  project_id: query.projectId, repository_id: query.repositoryId, revision: "content-1", analysis_id: "analysis-1",
  path: query.path, language: "TypeScript", line_count: 220, symbols, total_symbols: symbols.length, truncated: false,
  ...extra });

test("every section of the file reaches the phone in the code map's own shape", () => {
  const sections = Array.from({ length: 11 }, (_, index) => symbol(index));
  const result = codeFileResult(query, { status: "ok", file: file(sections) }, 5);
  assert.equal(Payload.parse(result).type, "project.code_file.result");
  assert.equal(result.status, "ok");
  assert.equal(result.symbols.length, 11);
  assert.deepEqual(result.symbols[0], { id: `${query.path}#export-0`, label: "export0", kind: "function", startLine: 1,
    lineCount: 9, metrics: { measured: true, sourceLines: 9, cyclomatic: 2, maxLoopDepth: 1, callers: 0 } });
  assert.equal(result.symbols[1]!.metrics, undefined, "an unmeasured section stays unmeasured");
  assert.deepEqual([result.revision, result.analysisId, result.language, result.lineCount, result.totalSymbols,
    result.truncated, result.requestId, result.createdAt], ["content-1", "analysis-1", "TypeScript", 220, 11, false,
    "code-1", 5]);
});

test("a file without known language, size or analysis id leaves them out", () => {
  const result = codeFileResult(query, { status: "ok",
    file: file([symbol(0)], { analysis_id: null, language: null, line_count: null }) }, 5);
  assert.equal("analysisId" in result || "language" in result || "lineCount" in result, false);
});

test("an answer without sections says only why", () => {
  for (const status of ["analyzing", "not_found", "not_bound", "engine_unavailable", "analysis_failed"] as const) {
    assert.deepEqual(codeFileResult(query, { status }, 9), { type: "project.code_file.result", ...query, status,
      symbols: [], totalSymbols: 0, truncated: false, createdAt: 9 });
  }
});

test("trailing sections make way for the byte budget and the section limit, and the total stays", () => {
  const wide = Array.from({ length: 1_500 }, (_, index) => symbol(index, `${query.path}#${"x".repeat(400)}-${index}`));
  const fitted = codeFileResult(query, { status: "ok", file: file(wide) }, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= MAX_CODE_FILE_RESULT_BYTES);
  assert.ok(fitted.symbols.length > 200 && fitted.symbols.length < 1_500, String(fitted.symbols.length));
  assert.equal(fitted.symbols.at(-1)!.id, wide[fitted.symbols.length - 1]!.id, "the Engine's order is kept");
  assert.deepEqual([fitted.totalSymbols, fitted.truncated], [1_500, true]);
  const fewer = codeFileResult(query, { status: "ok", file: file(wide.slice(0, fitted.symbols.length + 1)) }, 5);
  assert.equal(fewer.symbols.length, fitted.symbols.length, "the longest prefix that fits is kept");
  const many = Array.from({ length: 2_400 }, (_, index): EngineCodeSymbol => ({ id: `s${index}`, label: "x", kind: "f",
    start_line: index + 1, line_count: 1 }));
  const limited = codeFileResult(query, { status: "ok", file: file(many, { total_symbols: 3_000, truncated: true }) }, 5);
  assert.deepEqual([limited.symbols.length, limited.totalSymbols, limited.truncated], [MAX_CODE_FILE_SYMBOLS, 3_000, true]);
});

test("a section the wire cannot carry is left out and marks the answer partial", () => {
  const result = codeFileResult(query, { status: "ok", file: file([symbol(0), symbol(1, "   ")]) }, 5);
  assert.deepEqual([result.symbols.length, result.totalSymbols, result.truncated], [1, 2, true]);
});
