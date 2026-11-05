import type { MeshSnapshot, ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";
import { fitRepositoryGraph } from "../../../engine/runtime/repository-graph/fit";

/**
 * A snapshot is sealed twice, with the task key and then for transport, and each base64 layer adds a
 * third; this plaintext budget keeps the sealed frame under the relay's 1.8 MB stored-message limit.
 */
export const MESH_SNAPSHOT_BUDGET_BYTES = 900_000;

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function cut(graph: ProjectRepositoryGraph, maxBytes: number): ProjectRepositoryGraph {
  return fitRepositoryGraph(graph, maxBytes)
    ?? { ...graph, codeMap: undefined, nodes: [], relations: [], truncated: true };
}

/**
 * Each repository graph is bounded on its own, so a Project bound to many checkouts outgrew the relay
 * as a whole. Graphs are shrunk first, then repository details and graphs are left out; the Project,
 * its tasks and its people are never cut here.
 */
export function fitMeshSnapshot(snapshot: MeshSnapshot, maxBytes = MESH_SNAPSHOT_BUDGET_BYTES): MeshSnapshot {
  if (size(snapshot) <= maxBytes) return snapshot;
  const graphs = snapshot.repositoryGraphs ?? [];
  let fitted = snapshot;
  for (const perGraph of graphs.length ? [96, 48, 24, 12] : []) {
    fitted = { ...fitted, repositoryGraphs: graphs.map(graph => ({ ...cut(graph, perGraph * 1_024), truncated: true })) };
    if (size(fitted) <= maxBytes) return fitted;
  }
  if (fitted.repositoryDetails) {
    fitted = { ...fitted, repositoryDetails: undefined };
    if (size(fitted) <= maxBytes) return fitted;
  }
  return { ...fitted, repositoryGraphs: undefined, repositoryDetails: undefined };
}
