import { createHash } from 'node:crypto';
import { CodingAgent, UserMessage, type SessionInfo } from '../../../../packages/protocol/schema';
import type { NativeQueueScope } from '../task-dispatch/sender/store';
import { readLimitContinuationState, writeLimitContinuationState, type ScheduledContinuation } from './store';

/** What the agent reads when the computer continues a chat its subscription had stopped. */
export const LIMIT_CONTINUE_PROMPT =
  'GrantTap: the subscription limit that stopped this chat has reset. Continue the work from where you stopped.';
/** The provider's clock and ours differ a little; arriving just before the reset would hit the limit again. */
export const LIMIT_CONTINUE_GRACE_MS = 60_000;
/** A chat left at a limit that reset longer ago than this was abandoned, not waiting; an update must not wake it. */
const STALE_AFTER_RESET_MS = 3_600_000;
const PREFIX = 'limit-continue-';

export type ContinuationQueue = {
  submit: (scope: NativeQueueScope, message: UserMessage, notBefore: number, createdAt: number) => Promise<unknown>;
  cancel: (scope: NativeQueueScope, id: string) => Promise<unknown>;
};

let registered: ContinuationQueue | undefined;
/** Only the persistent monitor owns the durable relay queue; session MCPs never schedule. */
export function registerLimitContinuationQueue(queue: ContinuationQueue | undefined): void { registered = queue; }

export function setAutoContinue(sessionId: string, enabled: boolean): void {
  const state = readLimitContinuationState();
  state.off = enabled ? state.off.filter(id => id !== sessionId) : [...state.off, sessionId];
  writeLimitContinuationState(state);
}

/** The phone shows whether a limited chat will go on by itself; that is the default. */
export function annotateLimitContinuations(sessions: SessionInfo[]): SessionInfo[] {
  if (!sessions.some(session => session.usageLimit)) return sessions;
  const off = new Set(readLimitContinuationState().off);
  return sessions.map(session => session.usageLimit
    ? { ...session, usageLimit: { ...session.usageLimit, autoContinue: !off.has(session.sessionId) } } : session);
}

function wanted(session: SessionInfo, off: Set<string>, now: number): boolean {
  const limit = session.usageLimit;
  return !!limit && session.agent === 'claude' && session.state === 'idle' && !off.has(session.sessionId)
    && limit.resetsAt > now - STALE_AFTER_RESET_MS;
}

function continuation(session: SessionInfo, now: number): { job: ScheduledContinuation; message: UserMessage } {
  const resetsAt = session.usageLimit!.resetsAt;
  const messageId = PREFIX + createHash('sha256').update(`${session.sessionId}:${resetsAt}`).digest('hex').slice(0, 40);
  const scope: NativeQueueScope = { sessionId: session.sessionId, provider: CodingAgent.parse(session.agent),
    ...(session.projectId ? { projectId: session.projectId } : {}), ...(session.taskId ? { taskId: session.taskId } : {}) };
  const cwd = session.worktree ?? session.cwd;
  const message = UserMessage.parse({ type: 'user.message', messageId, sessionId: session.sessionId, agent: session.agent,
    text: LIMIT_CONTINUE_PROMPT, createdAt: now, ...(cwd ? { cwd } : {}),
    ...(session.projectId ? { projectId: session.projectId } : {}) });
  return { job: { resetsAt, messageId, scope }, message };
}

/**
 * Puts one "continue" on the relay for every chat its subscription stopped, due when the limit resets,
 * and takes it back when the chat went on by itself or the person turned it off. The relay holds it
 * while this computer sleeps or the phone is away.
 */
export async function scheduleLimitContinuations(sessions: SessionInfo[], queue = registered, now = Date.now()): Promise<void> {
  if (!queue) return;
  const state = readLimitContinuationState(), off = new Set(state.off);
  const byId = new Map(sessions.map(session => [session.sessionId, session]));
  let changed = false;
  for (const [sessionId, job] of Object.entries(state.scheduled)) {
    const session = byId.get(sessionId);
    const current = session?.usageLimit?.resetsAt === job.resetsAt && wanted(session, off, now);
    const missing = !session && job.resetsAt > now - 7 * 86_400_000 && !off.has(sessionId);
    if (current || missing) continue;
    await queue.cancel(job.scope, job.messageId).catch(() => {});
    delete state.scheduled[sessionId]; changed = true;
  }
  for (const session of sessions) {
    if (!wanted(session, off, now) || state.scheduled[session.sessionId]) continue;
    const { job, message } = continuation(session, now);
    await queue.submit(job.scope, message, Math.max(now, job.resetsAt + LIMIT_CONTINUE_GRACE_MS), now);
    state.scheduled[session.sessionId] = job; changed = true;
  }
  if (changed) writeLimitContinuationState(state);
}

/** A continuation the relay hands back after the person turned it off, or for a limit since lifted, is not delivered. */
export function limitContinuationUnwanted(message: UserMessage): boolean {
  if (!message.messageId?.startsWith(PREFIX) || !message.sessionId) return false;
  const state = readLimitContinuationState();
  return state.off.includes(message.sessionId) || state.scheduled[message.sessionId]?.messageId !== message.messageId;
}
