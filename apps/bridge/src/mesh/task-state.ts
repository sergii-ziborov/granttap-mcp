/**
 * The only two places a Task changes state: a Mesh event, and the local catalog
 * reading live sessions. Both go through here so the ownership and terminal
 * rules in `convergence.ts` cannot be bypassed by one caller.
 */
import type {
  ExecutionSessionLink as ExecutionValue,
  HandoffReceipt as ReceiptValue,
  MeshEvent as MeshEventValue,
  MeshTask as TaskValue,
} from "../../../../packages/protocol/schema";
import { isTerminalTaskState, mayOwnTask, nextTaskRevision } from "./convergence";

function sameTask(left: TaskValue, right: TaskValue): boolean {
  return left.state === right.state
    && left.ownerSessionId === right.ownerSessionId
    && left.title === right.title
    && left.goal === right.goal
    && left.updatedAt === right.updatedAt;
}

/**
 * Whether a handoff receipt may move ownership.
 *
 * The ordinary case is the current owner handing its own Task on. A computer
 * that has been offline can legitimately hold an older owner, so a receipt is
 * still accepted there — unless this computer already saw that same session
 * hand the Task to someone else, which makes the receipt a replay of a decision
 * a newer one already replaced.
 */
export function receiptMovesOwnership(
  task: TaskValue,
  receipt: ReceiptValue,
  recorded: readonly ReceiptValue[] = [],
): boolean {
  if (task.ownerSessionId == null || task.ownerSessionId === receipt.sourceSessionId) return true;
  return !recorded.some((item) => item.taskId === receipt.taskId
    && item.sourceSessionId === receipt.sourceSessionId
    && item.targetSessionId !== receipt.targetSessionId);
}

/** The Task after one event, or `undefined` when the event changes nothing. */
export function taskAfterEvent(
  task: TaskValue,
  event: MeshEventValue,
): TaskValue | undefined {
  const next = { ...task };
  const finished = isTerminalTaskState(task.state);
  const receipt = event.payload.receipt;
  if (event.eventType === "HANDOFF_ACCEPTED" && receipt) {
    next.ownerSessionId = receipt.targetSessionId;
    if (!finished) next.state = "working";
  } else if (!finished) {
    next.state = liveState(task.state, event);
  }
  if (event.eventType === "TASK_COMPLETED") next.state = "completed";
  next.updatedAt = Math.max(task.updatedAt, event.createdAt);
  if (sameTask(task, next)) return undefined;
  next.revision = nextTaskRevision(task);
  return next;
}

function liveState(current: string, event: MeshEventValue): TaskValue["state"] {
  switch (event.eventType) {
    case "TASK_STARTED":
    case "TASK_PROGRESS":
      return "working";
    case "HANDOFF_REQUEST":
      return "handoff";
    case "TASK_BLOCKED":
      return event.payload.needsUser ? "needs_user" : "blocked";
    case "CONFLICT":
      return event.payload.resolved === true ? current as TaskValue["state"] : "needs_user";
    case "HANDOFF_REJECTED":
      return event.payload.failed ? "needs_user" : current as TaskValue["state"];
    default:
      return current as TaskValue["state"];
  }
}

/**
 * The Task after a local catalog reading of a live session.
 *
 * A session that is no longer the owner still publishes its own liveness, so it
 * may refresh the description but never take the Task back or reopen it.
 */
export function taskAfterLocalReading(
  previous: TaskValue,
  reading: TaskValue,
  executions: readonly ExecutionValue[],
): TaskValue | undefined {
  if (previous.updatedAt > reading.updatedAt) return undefined;
  const owns = reading.ownerSessionId != null
    && mayOwnTask(previous, reading.ownerSessionId, executions);
  const next: TaskValue = {
    ...previous,
    title: reading.title,
    goal: reading.goal,
    updatedAt: reading.updatedAt,
    ownerSessionId: owns ? reading.ownerSessionId : previous.ownerSessionId,
    state: owns && !isTerminalTaskState(previous.state) ? reading.state : previous.state,
  };
  if (sameTask(previous, next)) return undefined;
  next.revision = nextTaskRevision(previous);
  return next;
}
