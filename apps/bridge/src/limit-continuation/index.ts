import { createHash } from 'node:crypto';
import { CodingAgent, UserMessage, type ProviderAccountUsage, type SessionInfo } from '../../../../packages/protocol/schema';
import type { NativeQueueScope } from '../task-dispatch/sender/store';
import { limitLifted } from './lift';
import { readLimitContinuationState, writeLimitContinuationState, type LimitContinuationState,
  type ScheduledContinuation } from './store';

export { LIFT_BELOW_PERCENT, LIFT_READING_MAX_AGE_MS } from './lift';

/** What the agent reads when the computer continues a chat its subscription had stopped. */
export const LIMIT_CONTINUE_PROMPT =
  'GrantTap: the subscription limit that stopped this chat has reset. Continue the work from where you stopped.';
/** What the agent reads when the account's readings show the limit has room again before its reset. */
export const LIMIT_ROOM_PROMPT =
  'GrantTap: the subscription limit that stopped this chat has room again. Continue the work from where you stopped.';
/** The provider's clock and ours differ a little; arriving just before the reset would hit the limit again. */
export const LIMIT_CONTINUE_GRACE_MS = 60_000;
/** A chat left at a limit that reset longer ago than this was abandoned, not waiting; an update must not wake it. */
const STALE_AFTER_RESET_MS = 3_600_000;
const PREFIX = 'limit-continue-';
const EARLY_PREFIX = `${PREFIX}early-`;

export type ContinuationQueue = {
  submit: (scope: NativeQueueScope, message: UserMessage, notBefore: number, createdAt: number) => Promise<unknown>;
  cancel: (scope: NativeQueueScope, id: string) => Promise<unknown>;
};
/** The account's limit readings; asked only while a queued continuation could still go early. */
export type UsageReadings = () => ProviderAccountUsage[];

let registered: ContinuationQueue | undefined;
/** Only the persistent monitor owns the durable relay queue; session MCPs never schedule. */
export function registerLimitContinuationQueue(queue: ContinuationQueue | undefined): void { registered = queue; }

export function setAutoContinue(sessionId: string, enabled: boolean): void {
  const state = readLimitContinuationState();
  state.off = enabled ? state.off.filter(id => id !== sessionId) : [...state.off, sessionId];
  writeLimitContinuationState(state);
}

/**
 * The phone shows whether a limited chat will go on by itself; that is the default for Claude. Only
 * Claude chats are continued (`wanted`), so another agent's limited chat says it will not be.
 */
export function annotateLimitContinuations(sessions: SessionInfo[]): SessionInfo[] {
  if (!sessions.some(session => session.usageLimit)) return sessions;
  const off = new Set(readLimitContinuationState().off);
  return sessions.map(session => session.usageLimit ? { ...session, usageLimit: { ...session.usageLimit,
    autoContinue: session.agent === 'claude' && !off.has(session.sessionId) } } : session);
}

/**
 * For the chat itself: whether it goes on by itself after a subscription limit stopped it, and the
 * continuation queued for it while it waits at one. `early` says a second one was queued to go at once
 * because the account's readings showed room before the reset. Read only.
 */
export function limitContinuationFor(sessionId: string): { autoContinue: boolean; continuation?: { dueAt: number; early: boolean } } {
  const state = readLimitContinuationState(), job = state.scheduled[sessionId];
  return { autoContinue: !state.off.includes(sessionId),
    ...(job ? { continuation: { dueAt: Math.max(job.scheduledAt ?? 0, job.resetsAt + LIMIT_CONTINUE_GRACE_MS), early: !!job.early } } : {}) };
}

function wanted(session: SessionInfo, off: Set<string>, now: number): boolean {
  const limit = session.usageLimit;
  return !!limit && session.agent === 'claude' && session.state === 'idle' && !off.has(session.sessionId)
    && limit.resetsAt > now - STALE_AFTER_RESET_MS;
}

function continuation(session: SessionInfo, now: number, early = false): { job: ScheduledContinuation; message: UserMessage } {
  const resetsAt = session.usageLimit!.resetsAt;
  const messageId = (early ? EARLY_PREFIX : PREFIX) + createHash('sha256')
    .update(`${session.sessionId}:${resetsAt}${early ? ':early' : ''}`).digest('hex').slice(0, 40);
  const scope: NativeQueueScope = { sessionId: session.sessionId, provider: CodingAgent.parse(session.agent),
    ...(session.projectId ? { projectId: session.projectId } : {}), ...(session.taskId ? { taskId: session.taskId } : {}) };
  const cwd = session.worktree ?? session.cwd;
  const message = UserMessage.parse({ type: 'user.message', messageId, sessionId: session.sessionId, agent: session.agent,
    text: early ? LIMIT_ROOM_PROMPT : LIMIT_CONTINUE_PROMPT, createdAt: now, ...(cwd ? { cwd } : {}),
    ...(session.projectId ? { projectId: session.projectId } : {}) });
  return { job: { resetsAt, messageId, scope, scheduledAt: now }, message };
}

/** Takes back what the relay holds for chats that went on, were turned off or left the catalog long ago. */
async function withdraw(state: LimitContinuationState, byId: Map<string, SessionInfo>, off: Set<string>,
  queue: ContinuationQueue, now: number): Promise<boolean> {
  let changed = false;
  for (const [sessionId, job] of Object.entries(state.scheduled)) {
    const session = byId.get(sessionId);
    // The relay delivers only to an idle chat, so a chat busy for a moment (an early attempt the limit
    // refused again, a message of the person's) keeps its continuation. It is withdrawn only when the chat
    // is no longer held by that limit or the person turned it off.
    const current = session?.usageLimit?.resetsAt === job.resetsAt && !off.has(sessionId);
    const missing = !session && job.resetsAt > now - 7 * 86_400_000 && !off.has(sessionId);
    // A job queued before its time was recorded counts from now, so no older reading speaks for it.
    if (current && job.scheduledAt === undefined) { job.scheduledAt = now; changed = true; }
    if (current || missing) continue;
    for (const id of [job.messageId, ...(job.early ? [job.early] : [])]) await queue.cancel(job.scope, id).catch(() => {});
    delete state.scheduled[sessionId]; changed = true;
  }
  for (const [sessionId, resetsAt] of Object.entries(state.tried ?? {})) {
    if (resetsAt > now - STALE_AFTER_RESET_MS) continue;
    delete state.tried![sessionId]; changed = true;
  }
  return changed;
}

/**
 * Queues a second continuation, due at once, for a limited chat whose window the account's readings
 * show has room again before its reset. It is tried once per limit; the one due at the reset stays.
 */
async function continueEarly(state: LimitContinuationState, byId: Map<string, SessionInfo>, queue: ContinuationQueue,
  now: number, readings: UsageReadings): Promise<boolean> {
  const waiting = Object.entries(state.scheduled).flatMap(([sessionId, job]) => {
    const session = byId.get(sessionId);
    // A job queued this moment has no reading taken after it yet.
    return session?.usageLimit?.resetsAt === job.resetsAt && job.scheduledAt !== undefined && job.scheduledAt < now
      && !job.early && state.tried?.[sessionId] !== job.resetsAt && now < job.resetsAt
      ? [{ session, job, at: job.scheduledAt }] : [];
  });
  if (!waiting.length) return false;
  let usage: ProviderAccountUsage[] = [], changed = false;
  // Unreadable limits only mean nothing goes early; what this pass queued must still be recorded.
  try { usage = readings(); } catch { /* No readings. */ }
  for (const { session, job, at } of waiting) {
    if (!limitLifted(session.usageLimit!, at, usage, now)) continue;
    const { message } = continuation(session, now, true), tried = state.tried ??= {};
    // It is due at once, so delivery must already find it wanted.
    job.early = message.messageId; tried[session.sessionId] = job.resetsAt; changed = true;
    writeLimitContinuationState(state);
    try { await queue.submit(job.scope, message, now, now); }
    catch (error) { delete job.early; delete tried[session.sessionId]; writeLimitContinuationState(state); throw error; }
  }
  return changed;
}

/**
 * Puts one "continue" on the relay for every chat its subscription stopped, due when the limit resets,
 * and takes it back when the chat went on by itself or the person turned it off. The relay holds it
 * while this computer sleeps or the phone is away. When the account's readings show the window has
 * room again sooner, one more goes at once.
 */
export async function scheduleLimitContinuations(sessions: SessionInfo[], queue = registered, now = Date.now(),
  readings: UsageReadings = () => []): Promise<void> {
  if (!queue) return;
  const state = readLimitContinuationState(), off = new Set(state.off);
  const byId = new Map(sessions.map(session => [session.sessionId, session]));
  let changed = await withdraw(state, byId, off, queue, now);
  for (const session of sessions) {
    if (!wanted(session, off, now) || state.scheduled[session.sessionId]) continue;
    const { job, message } = continuation(session, now);
    await queue.submit(job.scope, message, Math.max(now, job.resetsAt + LIMIT_CONTINUE_GRACE_MS), now);
    state.scheduled[session.sessionId] = job; changed = true;
  }
  if (await continueEarly(state, byId, queue, now, readings)) changed = true;
  if (changed) writeLimitContinuationState(state);
}

/** A continuation the relay hands back after the person turned it off, or for a limit since lifted, is not delivered. */
export function limitContinuationUnwanted(message: UserMessage): boolean {
  if (!message.messageId?.startsWith(PREFIX) || !message.sessionId) return false;
  const state = readLimitContinuationState(), job = state.scheduled[message.sessionId];
  return state.off.includes(message.sessionId) || (job?.messageId !== message.messageId && job?.early !== message.messageId);
}
