import { MeshSnapshot, type MeshSnapshot as SnapshotValue } from "../../../../packages/protocol/schema";
import { preferExecution, preferTask } from "./convergence";
import { upsertBinding } from "./binding-state";
import { mergeBy, mergeWith } from "./store-support";
import type { StoreState } from "./store-state";

export function mergeSnapshotState(state: StoreState, input: SnapshotValue): void {
  const snapshot = MeshSnapshot.parse(input);
  const candidate = structuredClone(state);
  candidate.projects = mergeBy(candidate.projects, [snapshot.project], (item) => item.projectId);
  for (const binding of snapshot.bindings ?? []) {
    candidate.bindings = upsertBinding(candidate, binding).bindings;
  }
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
