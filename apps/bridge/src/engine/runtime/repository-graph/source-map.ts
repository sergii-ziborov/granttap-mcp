import type { EngineRepositoryGraph } from "../../protocol/engine-protocol";
import type { ProjectCodeMap } from "../../../../../../packages/protocol/messages/mesh/graph/code-map";

/** Preserve optional source checks without turning absent measurements into zero. */
export function repositorySourceMap(graph: EngineRepositoryGraph): ProjectCodeMap | undefined {
  const map = graph.code_map;
  if (!map) return undefined;
  return {
    files: map.files.map(file => ({ path: file.path, language: file.language, lineCount: file.line_count,
      symbols: file.symbols.map(symbol => ({
        id: symbol.id, label: symbol.label, kind: symbol.kind, startLine: symbol.start_line, lineCount: symbol.line_count,
        ...(symbol.metrics?.measured === true ? { metrics: {
          measured: true as const, sourceLines: symbol.metrics.source_lines, cyclomatic: symbol.metrics.cyclomatic,
          maxLoopDepth: symbol.metrics.max_loop_depth, callers: symbol.metrics.callers,
        } } : {}),
      })),
    })),
    externals: map.externals ?? [], roads: map.roads, totalFiles: map.total_files,
    totalExternals: map.total_externals ?? 0, truncated: map.truncated,
  };
}
