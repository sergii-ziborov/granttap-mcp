import { MeshSnapshot, type MeshSnapshot as SnapshotValue } from "../../../../../packages/protocol/schema";
import { preferExecution, preferTask } from "../admin/convergence";
import { upsertBinding } from "../catalog/binding-state";
import { integrationPeerKey } from "../handoff/other-side";
import { mergeBy, mergeWith } from "../store/support";
import { MAX_STORE_PEERS, type StoreState } from "../store/state";

export function mergeSnapshotState(state: StoreState, input: SnapshotValue): void {
  const snapshot = MeshSnapshot.parse(input);
  const candidate = structuredClone(state);
  const existing = candidate.projects.find((item) => item.projectId === snapshot.projectId);
  if (existing && existing.canonicalRepositoryId !== snapshot.project.canonicalRepositoryId) {
    throw new Error("Project identity conflict");
  }
  // repositoryRoot is an endpoint-local path. A snapshot from another
  // computer cannot replace this endpoint's verified checkout binding.
  const project = existing?.repositoryRoot
    ? { ...snapshot.project, repositoryRoot: existing.repositoryRoot }
    : snapshot.project;
  candidate.projects = mergeBy(candidate.projects, [project], (item) => item.projectId);
  for (const binding of snapshot.bindings ?? []) {
    candidate.bindings = upsertBinding(candidate, binding).bindings;
  }
  candidate.peers = mergeBy(candidate.peers, snapshot.peers ?? [], integrationPeerKey)
    .slice(-MAX_STORE_PEERS);
  candidate.tasks = mergeWith(candidate.tasks, snapshot.tasks, (item) => item.taskId, preferTask);
  candidate.executions = mergeWith(
    candidate.executions,
    snapshot.executions,
    (item) => `${item.computerId}\0${item.provider}\0${item.sessionId}`,
    preferExecution,
  );
  candidate.claims = mergeBy(candidate.claims, snapshot.claims, (item) => item.claimId);
  candidate.dependencies = mergeBy(
    candidate.dependencies,
    snapshot.dependencies,
    (item) => `${item.taskId}\0${item.dependsOnTaskId}`,
  );
  candidate.events = mergeBy(candidate.events, snapshot.events, (item) => item.eventId).slice(-512);
  Object.assign(state, candidate);
}
