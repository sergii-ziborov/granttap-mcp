/**
 * The other side of a Task's repository.
 *
 * A Project binds several repositories, and a bound repository's integration
 * map says which of them sit on the far side of its databases, topics, and
 * APIs. Put the two together and the Mesh can answer the question a merge
 * never does: is someone, right now, changing the other half of the contract
 * this Task is changing? Shared with the phone vector for vector.
 */
import { basename } from "node:path";
import type {
  ExecutionSessionLink,
  IntegrationPeer,
  IntegrationRelation,
  IntegrationVia,
  MeshSnapshot,
  ProjectBindingSummary,
} from "../../../../packages/protocol/schema";

const MAX_ROWS = 32;

export function integrationPeerKey(peer: IntegrationPeer): string {
  return [peer.projectId, peer.repositoryId, peer.peer, peer.via, peer.relation, peer.through ?? ""]
    .join("\0");
}

/** The names a repository answers to on a map: what its checkout directory is called. */
export function repositoryNames(
  binding: Pick<ProjectBindingSummary, "repositoryId" | "displayName" | "localPathHint">,
): Set<string> {
  const names = new Set<string>();
  const add = (value: string | undefined): void => {
    const name = (value ?? "").trim().toLowerCase();
    if (name) names.add(name);
  };
  add(binding.displayName);
  add(binding.localPathHint ? basename(binding.localPathHint) : undefined);
  add(binding.repositoryId.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, ""));
  return names;
}

function repositoryIdsNamed(name: string, bindings: ProjectBindingSummary[]): string[] {
  const wanted = name.trim().toLowerCase();
  return [...new Set(
    bindings.filter((binding) => repositoryNames(binding).has(wanted)).map((binding) => binding.repositoryId),
  )];
}

export type OtherSideEdge = { peer: IntegrationPeer; repositoryId: string };

/** Repositories on the far side of `repositoryId`, whichever side stated the edge. */
export function otherSides(
  repositoryId: string,
  snapshot: Pick<MeshSnapshot, "peers" | "bindings">,
): OtherSideEdge[] {
  const bindings = snapshot.bindings ?? [];
  const mine = new Set(
    bindings.filter((binding) => binding.repositoryId === repositoryId)
      .flatMap((binding) => [...repositoryNames(binding)]),
  );
  const edges: OtherSideEdge[] = [];
  for (const peer of snapshot.peers ?? []) {
    if (peer.repositoryId === repositoryId) {
      for (const id of repositoryIdsNamed(peer.peer, bindings)) {
        if (id !== repositoryId) edges.push({ peer, repositoryId: id });
      }
    } else if (mine.has(peer.peer.trim().toLowerCase())) {
      edges.push({ peer, repositoryId: peer.repositoryId });
    }
  }
  return edges;
}

/** The repository an execution runs in, when the snapshot can tell. */
export function executionRepository(
  execution: ExecutionSessionLink,
  snapshot: Pick<MeshSnapshot, "project">,
): string | undefined {
  if (execution.repositoryId) return execution.repositoryId;
  const root = snapshot.project.repositoryRoot;
  if (!root) return undefined;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return execution.workspace === root || execution.workspace.startsWith(prefix)
    ? snapshot.project.canonicalRepositoryId
    : undefined;
}

export type OtherSideRow = {
  taskId: string;
  title: string;
  ownerSessionId?: string;
  /** The repository that Task is working in. */
  repositoryId: string;
  via: IntegrationVia;
  relation: IntegrationRelation;
  through?: string;
  /** The repository whose map states the edge. */
  statedBy: string;
};

/** Other Tasks working, right now, on the far side of this Task's repositories. */
export function otherSide(snapshot: MeshSnapshot, taskId: string): OtherSideRow[] {
  const live = snapshot.executions.filter((execution) => execution.endedAt == null);
  const mine = new Set(
    live.filter((execution) => execution.taskId === taskId)
      .flatMap((execution) => {
        const repository = executionRepository(execution, snapshot);
        return repository ? [repository] : [];
      }),
  );
  const rows: OtherSideRow[] = [];
  const seen = new Set<string>();
  for (const repositoryId of mine) {
    for (const edge of otherSides(repositoryId, snapshot)) {
      for (const execution of live) {
        if (execution.taskId === taskId
          || executionRepository(execution, snapshot) !== edge.repositoryId) continue;
        const task = snapshot.tasks.find((item) => item.taskId === execution.taskId);
        if (!task) continue;
        const key = `${task.taskId}\0${integrationPeerKey(edge.peer)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          taskId: task.taskId,
          title: task.title,
          ownerSessionId: task.ownerSessionId,
          repositoryId: edge.repositoryId,
          via: edge.peer.via,
          relation: edge.peer.relation,
          through: edge.peer.through,
          statedBy: edge.peer.repositoryId,
        });
      }
    }
  }
  return rows.slice(0, MAX_ROWS);
}
