import type { ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";
import { representativeSourcePaths, canReduceSymbols, sampleSymbols } from "./source-sampling";

type CodeMap = NonNullable<ProjectRepositoryGraph["codeMap"]>;
type Relation = ProjectRepositoryGraph["relations"][number];

/** Keep a navigable code city and the strongest architecture evidence in the snapshot envelope. */
export function fitRepositoryGraph(
  graph: ProjectRepositoryGraph,
  maxBytes: number,
): ProjectRepositoryGraph | undefined {
  let bounded = graph;
  const bytes = () => Buffer.byteLength(JSON.stringify(bounded), "utf8");
  if (bytes() <= maxBytes) return bounded;
  if (bounded.relations.length > 128) {
    bounded = { ...bounded, relations: strongestRelations(bounded.relations, 128), truncated: true };
  }
  while (bytes() > maxBytes) {
    const map = bounded.codeMap;
    // Dense import graphs must not consume the source-section budget. Keep
    // observed directed links across the inventory before reducing symbols.
    if (map && map.roads.length > 16
      && Buffer.byteLength(JSON.stringify(map.roads), "utf8") > maxBytes / 3) {
      bounded = { ...bounded, codeMap: trimRoads(map) };
    } else if (map && canReduceSymbols(map)) {
      bounded = { ...bounded, codeMap: trimSymbols(map) };
    } else if (bounded.relations.length > 8) {
      bounded = { ...bounded, relations: strongestRelations(bounded.relations,
        Math.ceil(bounded.relations.length / 2)), truncated: true };
    } else if (bounded.nodes.length > 8) {
      const nodes = bounded.nodes.slice(0, Math.ceil(bounded.nodes.length / 2));
      const ids = new Set(nodes.map((node) => node.id));
      bounded = { ...bounded, nodes, relations: bounded.relations.filter((edge) =>
        ids.has(edge.source) && ids.has(edge.target)), truncated: true };
    } else if (map && map.roads.length > 16) {
      bounded = { ...bounded, codeMap: trimRoads(map) };
    } else if (map && map.files.length > 8) {
      bounded = { ...bounded, codeMap: trimFiles(map) };
    } else if (map) {
      bounded = { ...bounded, codeMap: undefined };
    } else {
      return undefined;
    }
  }
  return bounded;
}

function trimRoads(map: CodeMap): CodeMap {
  const limit = Math.max(16, Math.ceil(map.roads.length / 2));
  const kept = new Set<number>(), endpoints = new Set<string>();
  for (const [index, road] of map.roads.entries()) {
    if (kept.size === limit) break;
    if (endpoints.has(road.source) && endpoints.has(road.target)) continue;
    kept.add(index);
    endpoints.add(road.source);
    endpoints.add(road.target);
  }
  for (let index = 0; kept.size < limit; index++) kept.add(index);
  return { ...map, truncated: true, roads: map.roads.filter((_, index) => kept.has(index)) };
}

function strongestRelations(relations: Relation[], limit: number): Relation[] {
  return relations.map((edge, index) => ({ edge, index }))
    .sort((left, right) => (right.edge.evidenceCount ?? 0) - (left.edge.evidenceCount ?? 0)
      || left.index - right.index)
    .slice(0, limit).sort((left, right) => left.index - right.index)
    .map(({ edge }) => edge);
}

function roadDegree(map: CodeMap): Map<string, number> {
  const degree = new Map<string, number>();
  for (const road of map.roads) {
    degree.set(road.source, (degree.get(road.source) ?? 0) + 1);
    degree.set(road.target, (degree.get(road.target) ?? 0) + 1);
  }
  return degree;
}

function rankedFiles(map: CodeMap, preserveSource = false): CodeMap["files"] {
  const degree = roadDegree(map);
  const representatives = preserveSource ? representativeSourcePaths(map) : new Set<string>();
  return [...map.files].sort((left, right) =>
    Number(representatives.has(right.path)) - Number(representatives.has(left.path))
      || (preserveSource ? Number(right.symbols.length > 0) - Number(left.symbols.length > 0) : 0)
      || (degree.get(right.path) ?? 0) - (degree.get(left.path) ?? 0)
      || (right.lineCount ?? 0) - (left.lineCount ?? 0)
      || left.path.localeCompare(right.path));
}

function trimSymbols(map: CodeMap): CodeMap {
  const ranked = rankedFiles(map).filter((file) => file.symbols.length > 0);
  if (ranked.length <= 16) return { ...map, truncated: true,
    files: map.files.map(file => ({ ...file, symbols: sampleSymbols(file.symbols) })) };
  const candidates = [...representativeSourcePaths(map), ...ranked.map(file => file.path)];
  const keep = new Set([...new Set(candidates)].slice(0, Math.max(16, Math.floor(ranked.length / 2))));
  return { ...map, truncated: true, files: map.files.map((file) => {
    if (!keep.has(file.path)) return { ...file, symbols: [] };
    return file;
  }) };
}

function trimFiles(map: CodeMap): CodeMap {
  const files = rankedFiles(map, true).slice(0, Math.ceil(map.files.length / 2))
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set(files.map((file) => file.path));
  for (const external of map.externals ?? []) paths.add(external.id);
  return { ...map, files, truncated: true,
    roads: map.roads.filter((road) => paths.has(road.source) && paths.has(road.target)) };
}
