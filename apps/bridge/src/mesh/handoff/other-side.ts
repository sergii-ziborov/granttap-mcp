/**
 * The other side of a Task's repository.
 *
 * A Project binds several repositories. GrantTap Engine and Weavatrix Rust
 * identify the repository owners on each side of a verified relation. The
 * legacy peer map remains a compatibility fallback for older computers.
 */
import { basename } from "node:path";
import type {
  ExecutionSessionLink,
  IntegrationPeer,
  MeshSnapshot,
  ProjectBackbone,
  ProjectBindingSummary,
} from "../../../../../packages/protocol/schema";

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

export type OtherSideEdge = {
  repositoryId: string;
  statedBy: string;
  via: string;
  relation: string;
  through?: string;
};

function backboneOwners(
  backbone: ProjectBackbone,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const node of backbone.nodes.filter((item) => item.kind === "repository")) {
    owners.set(node.identity, node.identity);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    for (const relation of backbone.relations.filter((item) => item.relation === "owns")) {
      const owner = owners.get(relation.source);
      if (owner) owners.set(relation.target, owner);
    }
  }
  return owners;
}

function backboneOtherSides(
  repositoryId: string,
  backbone: ProjectBackbone | undefined,
): OtherSideEdge[] {
  if (!backbone) return [];
  const owners = backboneOwners(backbone);
  const seen = new Set<string>();
  return backbone.relations.flatMap((relation) => {
    const source = owners.get(relation.source);
    const target = owners.get(relation.target);
    if (!source || !target || source === target) return [];
    const other = source === repositoryId ? target : target === repositoryId ? source : undefined;
    if (!other) return [];
    const key = [repositoryId, other, relation.relation].join("\0");
    if (!seen.add(key)) return [];
    return [{
      repositoryId: other,
      statedBy: source,
      via: "engine",
      relation: relation.relation,
      through: `${relation.evidenceCount} evidence`,
    }];
  });
}

/** Repositories on the far side of `repositoryId`, whichever side stated the edge. */
export function otherSides(
  repositoryId: string,
  snapshot: Pick<MeshSnapshot, "backbone" | "peers" | "bindings">,
): OtherSideEdge[] {
  const bindings = snapshot.bindings ?? [];
  const verified = backboneOtherSides(repositoryId, snapshot.backbone);
  if (verified.length > 0) return verified;
  const mine = new Set(
    bindings.filter((binding) => binding.repositoryId === repositoryId)
      .flatMap((binding) => [...repositoryNames(binding)]),
  );
  const edges: OtherSideEdge[] = [];
  for (const peer of snapshot.peers ?? []) {
    if (peer.repositoryId === repositoryId) {
      for (const id of repositoryIdsNamed(peer.peer, bindings)) {
        if (id !== repositoryId) edges.push({
          repositoryId: id, statedBy: peer.repositoryId,
          via: peer.via, relation: peer.relation, through: peer.through,
        });
      }
    } else if (mine.has(peer.peer.trim().toLowerCase())) {
      edges.push({
        repositoryId: peer.repositoryId, statedBy: peer.repositoryId,
        via: peer.via, relation: peer.relation, through: peer.through,
      });
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
  via: string;
  relation: string;
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
        const key = [task.taskId, edge.repositoryId, edge.statedBy,
          edge.via, edge.relation, edge.through ?? ""].join("\0");
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          taskId: task.taskId,
          title: task.title,
          ownerSessionId: task.ownerSessionId,
          repositoryId: edge.repositoryId,
          via: edge.via,
          relation: edge.relation,
          through: edge.through,
          statedBy: edge.statedBy,
        });
      }
    }
  }
  return rows.slice(0, MAX_ROWS);
}
