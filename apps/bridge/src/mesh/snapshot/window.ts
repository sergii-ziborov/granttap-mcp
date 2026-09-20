import {
  MeshSnapshot,
  type MeshSnapshot as SnapshotValue,
  type MeshTask as TaskValue,
} from "../../../../../packages/protocol/schema";
import { isTerminalTaskState } from "../admin/convergence";

const MAX_SNAPSHOT_TASKS = 64;

/** Keep the newest window, plus older work that is still live. */
export function selectSnapshotTasks(all: TaskValue[]): {
  tasks: TaskValue[];
  incomplete: boolean;
} {
  const ordered = [...all].sort((left, right) =>
    left.updatedAt - right.updatedAt || left.taskId.localeCompare(right.taskId));
  const recent = ordered.slice(-MAX_SNAPSHOT_TASKS);
  const recentIds = new Set(recent.map((task) => task.taskId));
  const extraActive = all.filter((task) =>
    !recentIds.has(task.taskId) && !isTerminalTaskState(task.state));
  const selected = [...recent];
  for (const task of extraActive) {
    const drop = selected.findIndex((item) => isTerminalTaskState(item.state));
    if (selected.length < MAX_SNAPSHOT_TASKS) {
      selected.push(task);
      continue;
    }
    if (drop < 0) break;
    selected.splice(drop, 1);
    selected.push(task);
  }
  const tasks = selected.length > MAX_SNAPSHOT_TASKS
    ? [...selected].sort((left, right) => left.updatedAt - right.updatedAt).slice(-MAX_SNAPSHOT_TASKS)
    : selected;
  return { tasks, incomplete: all.length > tasks.length };
}

/** Hide tasks a scoped credential is not allowed to read. */
export function projectScopedSnapshot(
  snapshot: SnapshotValue | undefined,
  taskIds?: string[],
): SnapshotValue | undefined {
  if (!snapshot) return undefined;
  if (taskIds == null) return snapshot;
  const allowed = new Set(taskIds);
  const tasks = snapshot.tasks.filter((task) => allowed.has(task.taskId));
  const ids = new Set(tasks.map((task) => task.taskId));
  return MeshSnapshot.parse({
    ...snapshot,
    tasks,
    executions: snapshot.executions.filter((item) => ids.has(item.taskId)),
    claims: snapshot.claims.filter((item) => ids.has(item.taskId)),
    dependencies: snapshot.dependencies.filter((item) => ids.has(item.taskId)),
    events: snapshot.events.filter((item) => ids.has(item.taskId)),
  });
}

/** Filter first, then rank. Search never sees a task the credential hid. */
export function searchScopedSnapshot(
  snapshot: SnapshotValue | undefined,
  query: string,
  taskIds?: string[],
): {
  tasks: SnapshotValue["tasks"];
  events: SnapshotValue["events"];
  claims: SnapshotValue["claims"];
} {
  const permitted = projectScopedSnapshot(snapshot, taskIds);
  if (!permitted) return { tasks: [], events: [], claims: [] };
  const needle = query.trim().toLowerCase();
  const match = (value: string | undefined) =>
    !needle || (value != null && value.toLowerCase().includes(needle));
  return {
    tasks: permitted.tasks.filter((task) => match(task.taskId) || match(task.title) || match(task.goal)),
    events: permitted.events.filter((event) =>
      match(event.eventId)
      || match(event.eventType)
      || match(event.payload.summary)
      || match(event.payload.question)
      || match(event.payload.answer)
      || match(event.payload.reason)),
    claims: permitted.claims.filter((claim) =>
      match(claim.claimId) || match(claim.resource) || match(claim.taskId)),
  };
}
