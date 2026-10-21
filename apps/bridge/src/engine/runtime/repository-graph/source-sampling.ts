import type { ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";

type CodeMap = NonNullable<ProjectRepositoryGraph["codeMap"]>;
type Symbol = CodeMap["files"][number]["symbols"][number];

/** Reserve actual measured checks and a small sample of distinct source kinds. */
export function representativeSourcePaths(map: CodeMap): Set<string> {
  const paths = new Set<string>();
  const measured = map.files.find(file => file.symbols.some(symbol => symbol.metrics?.measured));
  if (measured) paths.add(measured.path);
  const kinds = new Set<string>();
  for (const file of map.files) for (const symbol of file.symbols) {
    if (kinds.has(symbol.kind) || paths.size >= 8) continue;
    kinds.add(symbol.kind); paths.add(file.path);
  }
  return paths;
}

export function canReduceSymbols(map: CodeMap): boolean {
  return map.files.filter(file => file.symbols.length > 0).length > 16
    || map.files.some(file => file.symbols.length > 1);
}

export function sampleSymbols(symbols: Symbol[]): Symbol[] {
  if (symbols.length <= 1) return symbols;
  const keep = new Set<Symbol>(), kinds = new Set<string>();
  const limit = Math.max(1, Math.floor(symbols.length / 2));
  const measured = symbols.find(symbol => symbol.metrics?.measured);
  if (measured) { keep.add(measured); kinds.add(measured.kind); }
  for (const symbol of symbols) {
    if (keep.size >= limit) break;
    if (!kinds.has(symbol.kind)) { keep.add(symbol); kinds.add(symbol.kind); }
  }
  for (const symbol of symbols) {
    if (keep.size >= limit) break;
    keep.add(symbol);
  }
  return symbols.filter(symbol => keep.has(symbol));
}
