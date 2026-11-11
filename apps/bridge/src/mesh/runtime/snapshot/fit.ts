import type { MeshSnapshot, ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";
import { fitRepositoryGraph } from "../../../engine/runtime/repository-graph/fit";

/**
 * Every iPhone build drops a Mesh snapshot whose plaintext is larger than 256 KiB. Fitting only to the
 * relay's 1.8 MB stored-frame limit let a requested Graph reach the phone and vanish there: the build
 * spun until it failed, on exactly the Projects with the most work in them. The relay limit is far above this.
 */
export const MESH_SNAPSHOT_BUDGET_BYTES = 256 * 1_024;
/** A busy Project's Graph keeps half the envelope before its older events and executions are left out. */
const GRAPH_FLOOR_BYTES = 128 * 1_024;

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The repository stays named, so the phone's requested build is answered rather than left waiting. */
function emptied(graph: ProjectRepositoryGraph): ProjectRepositoryGraph {
  return { ...graph, codeMap: undefined, architectureHypotheses: undefined, nodes: [], relations: [], truncated: true };
}

/** Fair shares of the room, smallest reports first so an unused share passes to the larger ones. */
function fitGraphs(graphs: ProjectRepositoryGraph[], room: number): ProjectRepositoryGraph[] {
  const fitted = [...graphs];
  const order = graphs.map((graph, index) => ({ index, bytes: size(graph) })).sort((a, b) => a.bytes - b.bytes);
  let remaining = room - graphs.length;
  for (const [position, { index, bytes }] of order.entries()) {
    const graph = graphs[index]!;
    const share = Math.floor(remaining / (graphs.length - position));
    const kept = bytes <= share ? graph : share >= 1_024 ? fitRepositoryGraph(graph, share) : undefined;
    fitted[index] = kept === graph ? graph : kept ? { ...kept, truncated: true } : emptied(graph);
    remaining -= size(fitted[index]);
  }
  return fitted;
}

/** The phone merges these by id, so an earlier snapshot already gave it the oldest ones. */
function withoutOldest(snapshot: MeshSnapshot, key: "events" | "executions", maxBytes: number): MeshSnapshot {
  let excess = size(snapshot) - maxBytes;
  if (excess <= 0) return snapshot;
  const items: unknown[] = snapshot[key];
  let cut = 0;
  while (cut < items.length && excess > 0) excess -= size(items[cut++]) + 1;
  return { ...snapshot, [key]: items.slice(cut) };
}

/**
 * Graphs are shrunk into the room the rest leaves, but not below their floor while repository details,
 * older events and older executions can make way. The Project, its Tasks and its people are never cut.
 */
export function fitMeshSnapshot(snapshot: MeshSnapshot, maxBytes = MESH_SNAPSHOT_BUDGET_BYTES): MeshSnapshot {
  if (size(snapshot) <= maxBytes) return snapshot;
  const graphs = snapshot.repositoryGraphs;
  const floor = Math.min(graphs ? size(graphs) : 0, GRAPH_FLOOR_BYTES);
  let rest: MeshSnapshot = { ...snapshot, repositoryGraphs: graphs?.map(emptied) };
  if (size(rest) + floor > maxBytes && rest.repositoryDetails) rest = { ...rest, repositoryDetails: undefined };
  rest = withoutOldest(withoutOldest(rest, "events", maxBytes - floor), "executions", maxBytes - floor);
  if (!graphs) return rest;
  return { ...rest, repositoryGraphs: fitGraphs(graphs, maxBytes - size({ ...rest, repositoryGraphs: [] })) };
}
