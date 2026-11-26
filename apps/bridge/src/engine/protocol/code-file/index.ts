import { parseCodeChecks } from "../transport/code-checks";
import { EngineProtocolError } from "../transport/protocol-base";

/** One source section as the Engine reports it; `metrics` is absent when it was not measured. */
export type EngineCodeSymbol = {
  id: string; label: string; kind: string; start_line: number; line_count: number;
  metrics?: { measured: boolean; source_lines: number; cyclomatic: number;
    max_loop_depth: number; callers: number } | null;
};

/** Every section of one file from the Engine's in-memory inventory of its last repository analysis. */
export type EngineCodeFile = {
  project_id: string;
  repository_id: string;
  revision: string;
  analysis_id: string | null;
  path: string;
  language: string | null;
  line_count: number | null;
  symbols: EngineCodeSymbol[];
  total_symbols: number;
  truncated: boolean;
};

/** Engine 0.1.10 `graph.code_file`: a read of memory filled by `graph.analyze_repository`, never a scan. */
export type CodeFileEngineOperation = {
  operation: "graph.code_file";
  input: { project_id: string; repository_id: string; path: string };
};
export type CodeFileEngineResult = { operation: "graph.code_file"; file: EngineCodeFile };

/** The frame limit bounds a file's sections long before this; it only refuses a malformed list. */
const MAX_ENGINE_CODE_FILE_SYMBOLS = 20_000;

/**
 * Validates the file under `file` (or `code_file`, or flattened beside `operation`) and returns it in
 * one shape. Absent measurements stay absent; malformed values fail the response.
 */
export function parseCodeFileResult(result: Record<string, unknown>): CodeFileEngineResult | undefined {
  if (result.operation !== "graph.code_file") return undefined;
  const raw = result.file ?? result.code_file ?? result;
  const file = object(raw);
  bounded(file.project_id, 128);
  bounded(file.repository_id, 512);
  bounded(file.revision, 512);
  optional(file.analysis_id, 128);
  bounded(file.path, 512);
  optional(file.language, 64);
  // An empty file may count zero lines; the phone then hears no line count rather than nothing at all.
  if (file.line_count != null && (!Number.isSafeInteger(file.line_count) || Number(file.line_count) < 0)) invalid();
  if (!Array.isArray(file.symbols) || file.symbols.length > MAX_ENGINE_CODE_FILE_SYMBOLS
    || !Number.isSafeInteger(file.total_symbols) || Number(file.total_symbols) < file.symbols.length
    || typeof file.truncated !== "boolean") invalid();
  for (const value of file.symbols) {
    const symbol = object(value);
    bounded(symbol.id, 512);
    bounded(symbol.label, 160);
    bounded(symbol.kind, 64);
    parseCodeChecks(symbol.metrics);
    if (!positive(symbol.start_line) || !positive(symbol.line_count)) invalid();
  }
  return {
    operation: "graph.code_file",
    file: {
      project_id: file.project_id as string, repository_id: file.repository_id as string,
      revision: file.revision as string, analysis_id: (file.analysis_id as string | undefined) ?? null,
      path: file.path as string, language: (file.language as string | undefined) ?? null,
      line_count: Number(file.line_count) > 0 ? file.line_count as number : null,
      symbols: file.symbols as EngineCodeSymbol[], total_symbols: file.total_symbols as number,
      truncated: file.truncated as boolean,
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function bounded(value: unknown, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) invalid();
}

function optional(value: unknown, maximum: number): void {
  if (value != null) bounded(value, maximum);
}

function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function invalid(): never {
  throw new EngineProtocolError("engine code file result is invalid");
}
