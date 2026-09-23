import type { ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";

/** Preserve component evidence and a usable code map within the snapshot envelope. */
export function fitRepositoryGraph(
  graph: ProjectRepositoryGraph,
  maxBytes: number,
): ProjectRepositoryGraph | undefined {
  let bounded = graph;
  const bytes = () => Buffer.byteLength(JSON.stringify(bounded), "utf8");
  while (bytes() > maxBytes) {
    const map = bounded.codeMap;
    if (map?.files.some((file) => file.symbols.length > 1)) {
      bounded = { ...bounded, codeMap: { ...map, truncated: true,
        files: map.files.map((file) => ({ ...file,
          symbols: file.symbols.slice(0, Math.ceil(file.symbols.length / 2)) })) } };
    } else if (map && map.roads.length > 16) {
      bounded = { ...bounded, codeMap: { ...map, truncated: true,
        roads: map.roads.slice(0, Math.ceil(map.roads.length / 2)) } };
    } else if (map && map.files.length > 8) {
      const degree = new Map<string, number>();
      for (const road of map.roads) {
        degree.set(road.source, (degree.get(road.source) ?? 0) + 1);
        degree.set(road.target, (degree.get(road.target) ?? 0) + 1);
      }
      const files = [...map.files].sort((left, right) =>
        (degree.get(right.path) ?? 0) - (degree.get(left.path) ?? 0)
          || (right.lineCount ?? 0) - (left.lineCount ?? 0)
          || left.path.localeCompare(right.path))
        .slice(0, Math.ceil(map.files.length / 2))
        .sort((left, right) => left.path.localeCompare(right.path));
      const paths = new Set(files.map((file) => file.path));
      bounded = { ...bounded, codeMap: { ...map, files, truncated: true,
        roads: map.roads.filter((road) => paths.has(road.source) && paths.has(road.target)) } };
    } else if (bounded.relations.length > 8) {
      bounded = { ...bounded, relations: bounded.relations.slice(0,
        Math.ceil(bounded.relations.length / 2)), truncated: true };
    } else if (bounded.nodes.length > 8) {
      const nodes = bounded.nodes.slice(0, Math.ceil(bounded.nodes.length / 2));
      const ids = new Set(nodes.map((node) => node.id));
      bounded = { ...bounded, nodes, relations: bounded.relations.filter((edge) =>
        ids.has(edge.source) && ids.has(edge.target)), truncated: true };
    } else if (map) {
      bounded = { ...bounded, codeMap: undefined };
    } else {
      return undefined;
    }
  }
  return bounded;
}
