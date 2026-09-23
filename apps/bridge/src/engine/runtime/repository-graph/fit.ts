import type { ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";

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
    if (map?.files.some((file) => file.symbols.length > 0)) {
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
      bounded = { ...bounded, codeMap: { ...map, truncated: true,
        roads: map.roads.slice(0, Math.ceil(map.roads.length / 2)) } };
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

function rankedFiles(map: CodeMap): CodeMap["files"] {
  const degree = roadDegree(map);
  return [...map.files].sort((left, right) =>
    (degree.get(right.path) ?? 0) - (degree.get(left.path) ?? 0)
      || (right.lineCount ?? 0) - (left.lineCount ?? 0)
      || left.path.localeCompare(right.path));
}

function trimSymbols(map: CodeMap): CodeMap {
  const ranked = rankedFiles(map).filter((file) => file.symbols.length > 0);
  const keep = new Set(ranked.slice(0, Math.floor(ranked.length / 2)).map((file) => file.path));
  return { ...map, truncated: true, files: map.files.map((file) => {
    if (!keep.has(file.path)) return { ...file, symbols: [] };
    if (ranked.length === 1) return { ...file, symbols: file.symbols.slice(0,
      Math.floor(file.symbols.length / 2)) };
    return file;
  }) };
}

function trimFiles(map: CodeMap): CodeMap {
  const files = rankedFiles(map).slice(0, Math.ceil(map.files.length / 2))
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set(files.map((file) => file.path));
  for (const external of map.externals ?? []) paths.add(external.id);
  return { ...map, files, truncated: true,
    roads: map.roads.filter((road) => paths.has(road.source) && paths.has(road.target)) };
}
