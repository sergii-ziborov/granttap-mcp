import { join } from 'node:path';
import type { TaskDispatch } from '../../../../../packages/protocol/schema';
import { configDir } from '../../config';
import { localTaskOrigins, resolveTaskOriginJob } from '../../task-origins';
import { waitingDispatchRecords } from '../inbox';
import type { StoredTaskDispatch } from '../records';

export type ConversationKey = (job: TaskDispatch, peer: string) => string;
type Delivered = { job: TaskDispatch; peerPublicKey: string };

/** Phases of a job that has not reached its chat yet and will when its turn comes. */
const WAITING = new Set(['staged', 'claimed']);

/**
 * The chat a queued job goes to: its own, or the one its new task became. Jobs of one key run one
 * at a time. New tasks of one provider share a key, so one creation finishes before the next starts.
 */
export function conversationKeyOf(resolve: (job: TaskDispatch, peer: string) => TaskDispatch | undefined): ConversationKey {
  return (job, peer) => resolve(job, peer)?.sessionId
    ?? (job.operation.type === 'user.message.continue'
      ? JSON.stringify([peer, job.operation.originMessageId]) : `new:${job.operation.agent ?? 'codex'}`);
}

/**
 * The jobs for the chat a delivery goes to. A new task has no chat id yet, so its chat's messages
 * are the follow-ups written for it, which name its origin. Other new tasks share its key but are
 * other chats, and a Project task (`project.task.create`) takes no follow-ups.
 */
function sameChat(delivered: Delivered, keyOf: ConversationKey): ((record: StoredTaskDispatch) => boolean) | undefined {
  const { job, peerPublicKey } = delivered, operation = job.operation;
  if (operation.type === 'project.task.create') return undefined;
  if (operation.type === 'user.message' && !job.sessionId) {
    const origin = operation.taskOriginId;
    return origin ? record => record.peerPublicKey === peerPublicKey
      && record.job.operation.type === 'user.message.continue' && record.job.operation.originMessageId === origin
      : undefined;
  }
  const key = keyOf(job, peerPublicKey);
  return record => keyOf(record.job, record.peerPublicKey) === key;
}

/**
 * How many messages from the phone wait for one chat. This computer's own queued work, such as a
 * limit continuation, is not from the phone. A message staged before a refused one of the same chat
 * waits for the person to cancel the refusal, not for this turn. Neither is counted.
 */
function waitingFor(records: StoredTaskDispatch[], ours: (record: StoredTaskDispatch) => boolean, except?: string): number {
  let refusedAt = -Infinity;
  for (const record of records) if (record.phase === 'rejected' && ours(record)) refusedAt = Math.max(refusedAt, record.updatedAt);
  return records.filter(record => record.job.jobId !== except && record.job.origin !== 'computer'
    && WAITING.has(record.phase) && record.stagedAt > refusedAt && ours(record)).length;
}

/** The phone messages that reach the same chat after `delivered`. */
export function queuedBehind(records: StoredTaskDispatch[], delivered: Delivered, keyOf: ConversationKey): number {
  const ours = sameChat(delivered, keyOf);
  return ours ? waitingFor(records, ours, delivered.job.jobId) : 0;
}

/**
 * For a status view in another process, such as a chat's own MCP server: the phone messages this
 * computer holds for `sessionId`. Reading creates nothing in the queue's directory.
 */
export function queuedPhoneMessages(sessionId: string, room: string, root = join(configDir(), 'task-dispatch')): number {
  return queuedForMessage(room, { sessionId }, root);
}

/**
 * For a message that reached this computer directly rather than through the queue: the phone messages
 * the queue holds for its chat, or for a new task the follow-ups written for it. A queued copy of the
 * same message is not counted.
 */
export function queuedForMessage(room: string, target: { sessionId?: string; taskOriginId?: string; peerPublicKey?: string;
  messageId?: string }, root = join(configDir(), 'task-dispatch')): number {
  const { sessionId, taskOriginId, peerPublicKey, messageId } = target;
  const origins = localTaskOrigins();
  const keyOf = conversationKeyOf((job, peer) => resolveTaskOriginJob(origins, job, room, peer).job);
  const ours = sessionId ? (record: StoredTaskDispatch) => keyOf(record.job, record.peerPublicKey) === sessionId
    : taskOriginId && peerPublicKey ? (record: StoredTaskDispatch) => record.peerPublicKey === peerPublicKey
      && record.job.operation.type === 'user.message.continue' && record.job.operation.originMessageId === taskOriginId
      : undefined;
  if (!ours) return 0;
  const records = waitingDispatchRecords(root, room).filter(record => !messageId
    || !('messageId' in record.job.operation) || record.job.operation.messageId !== messageId);
  return waitingFor(records, ours);
}
