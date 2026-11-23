import { createHash, randomBytes } from 'node:crypto';
import { CodingAgent, UserMessage } from '../../../../packages/protocol/schema';
import type { NativeQueueScope } from '../task-dispatch/sender/store';
import type { ContinuationCopy } from './store';

/** What the agent reads when the computer continues a chat its subscription had stopped. */
export const LIMIT_CONTINUE_PROMPT =
  'GrantTap: the subscription limit that stopped this chat has reset. Continue the work from where you stopped.';
/** What the agent reads when the account's readings show the limit has room again before its reset. */
export const LIMIT_ROOM_PROMPT =
  'GrantTap: the subscription limit that stopped this chat has room again. Continue the work from where you stopped.';
const PREFIX = 'limit-continue-';
const EARLY_PREFIX = `${PREFIX}early-`;

export type ContinuationQueue = {
  submit: (scope: NativeQueueScope, message: UserMessage, notBefore: number, createdAt: number) => Promise<unknown>;
  cancel: (scope: NativeQueueScope, id: string) => Promise<unknown>;
  /** What the relay holds under an id this computer queued; `null` when it holds nothing under it. */
  status?: (scope: NativeQueueScope, id: string) => Promise<{ state: string } | null>;
};

/** The chat a continuation is for, as its job keeps it. */
export type ContinuedChat = { sessionId: string; agent: string; projectId?: string; taskId?: string; cwd?: string };

export function isLimitContinuation(message: UserMessage): boolean {
  return !!message.messageId?.startsWith(PREFIX) && !!message.sessionId;
}

export function continuationScope(chat: ContinuedChat): NativeQueueScope {
  return { sessionId: chat.sessionId, provider: CodingAgent.parse(chat.agent),
    ...(chat.projectId ? { projectId: chat.projectId } : {}), ...(chat.taskId ? { taskId: chat.taskId } : {}) };
}

/**
 * A new copy of the continuation, not yet on the relay. Every copy has an id of its own: the relay keeps an
 * id it has seen, cancelled or delivered, for days, and refuses it for a different message. Reusing the id of
 * a limit the chat had been continued from once before was why a second refusal for that reset was never queued.
 */
export function continuationCopy(chat: ContinuedChat, resetsAt: number, now: number, notBefore: number, early: boolean)
  : ContinuationCopy {
  const messageId = (early ? EARLY_PREFIX : PREFIX) + createHash('sha256')
    .update(`${chat.sessionId}:${resetsAt}:${now}:${randomBytes(8).toString('hex')}`).digest('hex').slice(0, 40);
  const message = UserMessage.parse({ type: 'user.message', messageId, sessionId: chat.sessionId, agent: chat.agent,
    text: early ? LIMIT_ROOM_PROMPT : LIMIT_CONTINUE_PROMPT, createdAt: now, ...(chat.cwd ? { cwd: chat.cwd } : {}),
    ...(chat.projectId ? { projectId: chat.projectId } : {}) });
  return { messageId, notBefore, message, onRelay: false };
}

/** Why something failed, short enough for one log line and free of anything the chat said. */
export function failureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: unknown })?.status;
  return `${text.replace(/[.\s]+$/, '').slice(0, 120)}${typeof status === 'number' ? ` (HTTP ${status})` : ''}`;
}

/**
 * Puts a copy on the relay with exactly the message, due time and creation time it was recorded with, so a
 * retry after a failure, a restart or an update takeover stages the identical job. Returns why it could not.
 */
export async function putOnRelay(queue: ContinuationQueue, scope: NativeQueueScope, copy: ContinuationCopy)
  : Promise<string | undefined> {
  if (!copy.message) return 'its message was not kept';
  try { await queue.submit(scope, copy.message, copy.notBefore, copy.message.createdAt); return undefined; }
  catch (error) { return failureReason(error); }
}

/** Whether the relay still holds a copy: `undefined` when it could not be asked, else the relay's state or `gone`. */
export async function relayHolds(queue: ContinuationQueue, scope: NativeQueueScope, copy: ContinuationCopy)
  : Promise<{ holds: boolean; state: string } | undefined> {
  if (!queue.status) return undefined;
  try {
    const receipt = await queue.status(scope, copy.messageId);
    return { holds: !!receipt && ['queued', 'accepted'].includes(receipt.state), state: receipt?.state ?? 'unknown to it' };
  } catch { return undefined; }
}
