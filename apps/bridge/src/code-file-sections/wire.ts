import { MAX_CODE_FILE_RESULT_BYTES, MAX_CODE_FILE_SYMBOLS, ProjectCodeFileResult } from "../../../../packages/protocol/schema";
import { CodeSymbol } from "../../../../packages/protocol/messages/mesh/graph/code-map";
import type { EngineCodeSymbol } from "../engine/protocol/code-file";
import type { CodeFileAnswer, CodeFileKey } from ".";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * The phone's answer for one request. Sections keep the Engine's order; when they do not fit the
 * answer's byte budget the trailing ones make way and `truncated` says so, while `totalSymbols`
 * still counts every section of the file.
 */
export function codeFileResult(
  query: CodeFileKey & { requestId: string }, answer: CodeFileAnswer, createdAt: number,
): ProjectCodeFileResult {
  const base = {
    type: "project.code_file.result" as const, projectId: query.projectId, repositoryId: query.repositoryId,
    path: query.path, requestId: query.requestId,
  };
  if (answer.status !== "ok") {
    return ProjectCodeFileResult.parse({ ...base, status: answer.status, symbols: [], totalSymbols: 0,
      truncated: false, createdAt });
  }
  const file = answer.file;
  const sections = file.symbols.flatMap(symbol => {
    const parsed = CodeSymbol.safeParse(wireSymbol(symbol));
    return parsed.success ? [parsed.data] : [];
  });
  const listed = sections.slice(0, MAX_CODE_FILE_SYMBOLS);
  const result: ProjectCodeFileResult = {
    ...base, status: "ok",
    ...optional("revision", file.revision, 512),
    ...optional("analysisId", file.analysis_id, 128),
    ...optional("language", file.language, 64),
    ...(file.line_count != null && file.line_count > 0 ? { lineCount: file.line_count } : {}),
    symbols: listed,
    totalSymbols: Math.max(file.total_symbols, file.symbols.length),
    truncated: file.truncated || listed.length < file.symbols.length,
    createdAt,
  };
  return ProjectCodeFileResult.parse(fitted(result));
}

function wireSymbol(symbol: EngineCodeSymbol): CodeSymbol {
  return {
    id: symbol.id, label: symbol.label, kind: symbol.kind, startLine: symbol.start_line, lineCount: symbol.line_count,
    ...(symbol.metrics?.measured === true ? { metrics: {
      measured: true as const, sourceLines: symbol.metrics.source_lines, cyclomatic: symbol.metrics.cyclomatic,
      maxLoopDepth: symbol.metrics.max_loop_depth, callers: symbol.metrics.callers,
    } } : {}),
  };
}

function optional<K extends string>(key: K, value: string | null | undefined, maximum: number) {
  return value != null && value.trim().length > 0 && value.length <= maximum
    ? { [key]: value } as Record<K, string> : {};
}

/** Keep the longest prefix of sections that fits; JSON joins array items with one comma each. */
function fitted(result: ProjectCodeFileResult): ProjectCodeFileResult {
  if (bytes(result) <= MAX_CODE_FILE_RESULT_BYTES) return result;
  let used = bytes({ ...result, symbols: [], truncated: true });
  let kept = 0;
  for (const symbol of result.symbols) {
    const next = used + bytes(symbol) + (kept > 0 ? 1 : 0);
    if (next > MAX_CODE_FILE_RESULT_BYTES) break;
    used = next;
    kept += 1;
  }
  return { ...result, symbols: result.symbols.slice(0, kept), truncated: true };
}
