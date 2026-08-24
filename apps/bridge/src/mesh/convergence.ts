/**
 * Ordered convergence for Task state.
 *
 * Mesh state travels through delayed relays, background wakes, and reconnects,
 * so the same Task arrives out of order, more than once, and from several
 * computers. Blind last-writer-wins made a stale snapshot able to restore a
 * previous owner or turn finished work back into working. Every writer raises
 * `revision`, and these rules decide which version survives — identically on
 * every computer, so the Task converges instead of oscillating.
 */
import type {
  ExecutionSessionLink as ExecutionValue,
  MeshTask as TaskValue,
} from "../../../../packages/protocol/schema";

/** States a Task only leaves through an explicit newer decision. */
const TERMINAL_STATES = new Set(["completed", "failed"]);

export function isTerminalTaskState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

export function taskRevision(task: TaskValue): number {
  return task.revision ?? 0;
}

export function nextTaskRevision(task: TaskValue): number {
  return Math.min(taskRevision(task) + 1, Number.MAX_SAFE_INTEGER);
}

/** A total order, so both sides of a merge choose the same winner. */
export function preferTask(current: TaskValue, incoming: TaskValue): TaskValue {
  if (taskRevision(current) !== taskRevision(incoming)) {
    return taskRevision(incoming) > taskRevision(current) ? incoming : current;
  }
  if (current.updatedAt !== incoming.updatedAt) {
    return incoming.updatedAt > current.updatedAt ? incoming : current;
  }
  if (isTerminalTaskState(current.state) !== isTerminalTaskState(incoming.state)) {
    return isTerminalTaskState(incoming.state) ? incoming : current;
  }
  return taskOrderKey(incoming) > taskOrderKey(current) ? incoming : current;
}

function taskOrderKey(task: TaskValue): string {
  return `${task.state}\0${task.ownerSessionId ?? ""}\0${task.title}\0${task.goal}`;
}

/** An execution that has ended stays ended; otherwise the newer reading wins. */
export function preferExecution(
  current: ExecutionValue,
  incoming: ExecutionValue,
): ExecutionValue {
  if ((current.endedAt != null) !== (incoming.endedAt != null)) {
    const ended = current.endedAt != null ? current : incoming;
    const live = current.endedAt != null ? incoming : current;
    return { ...live, endedAt: ended.endedAt };
  }
  const currentAt = current.updatedAt ?? current.startedAt;
  const incomingAt = incoming.updatedAt ?? incoming.startedAt;
  if (currentAt !== incomingAt) return incomingAt > currentAt ? incoming : current;
  return JSON.stringify(incoming) > JSON.stringify(current) ? incoming : current;
}

/**
 * Whether `sessionId` may become the owner of `task`.
 *
 * Ownership moves forward only: to an unowned Task, back to the session that
 * already owns it, or away from an owner whose execution this computer can see
 * has ended. An owner this computer cannot see is treated as still working,
 * because guessing would be exactly the split brain this prevents.
 */
export function mayOwnTask(
  task: TaskValue,
  sessionId: string,
  executions: readonly ExecutionValue[],
): boolean {
  if (task.ownerSessionId == null || task.ownerSessionId === sessionId) return true;
  const owner = executions.find((item) =>
    item.taskId === task.taskId && item.sessionId === task.ownerSessionId);
  return owner?.endedAt != null;
}
