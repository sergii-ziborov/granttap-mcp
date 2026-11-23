import type { ProviderAccountUsage, SessionInfo } from '../../../../packages/protocol/schema';
import { limitLifted } from './lift';
import { continuationCopy, continuationScope, type ContinuedChat } from './relay-copies';
import { LIMIT_CONTINUE_GRACE_MS, type LimitContinuationState, type ScheduledContinuation } from './store';

/** A chat found at a limit that reset longer ago than this was abandoned, not waiting; an update must not wake it. */
export const STALE_AFTER_RESET_MS = 3_600_000;
/** The relay keeps a copy for a week after it is due; a chat still not free to take it by then is not continued. */
export const KEEP_AFTER_RESET_MS = 7 * 86_400_000;
/** Refused again for a reset whose continuation it was already given, the chat waits this long for the next. */
export const REFUSED_AGAIN_MS = 15 * 60_000;

/** The account's limit readings; asked only while a queued continuation could still go early. */
export type UsageReadings = () => ProviderAccountUsage[];
/** Why a waiting continuation ends; `done` ends it without a word, as it was delivered. */
export type Release = 'off' | 'expired' | 'another-limit' | 'went-on' | 'done';
export type NamedLimit = { sessionId: string; window?: string; resetsAt: number };
export type TakeBack = { scope: ScheduledContinuation['scope']; ids: string[] };

export const named = (sessionId: string, job: ScheduledContinuation): NamedLimit =>
  ({ sessionId, window: job.window, resetsAt: job.resetsAt });

/** The chat a job continues, in the folder the newest catalog shows for it. */
export function continuedChat(sessionId: string, job: ScheduledContinuation, session?: SessionInfo): ContinuedChat {
  return { sessionId, agent: job.scope.provider, projectId: job.scope.projectId, taskId: job.scope.taskId,
    cwd: session?.worktree ?? session?.cwd ?? job.regular.message?.cwd };
}

/**
 * Why a waiting continuation is no longer wanted, or `undefined` while its limit still holds the chat. A chat
 * that has not moved since it was refused is still held after its limit left the catalog, an hour after the
 * reset: the Mac may have slept through the reset. A chat missing from this catalog keeps its continuation.
 */
export function released(job: ScheduledContinuation, session: SessionInfo | undefined, off: boolean, now: number)
  : Release | undefined {
  if (off) return 'off';
  const delivered = job.regular.deliveredAt;
  const moved = !!session && (job.activityAt === undefined || session.lastActivityAt > job.activityAt);
  // Delivered, it is done once the chat moved; refused again for the same reset, the chat gets a job of its own.
  if (delivered !== undefined) return moved || now - delivered > STALE_AFTER_RESET_MS ? 'done' : undefined;
  if (now > job.resetsAt + LIMIT_CONTINUE_GRACE_MS + KEEP_AFTER_RESET_MS) return 'expired';
  if (!session) return undefined;
  const limit = session.usageLimit;
  if (limit?.resetsAt === job.resetsAt) return undefined;
  if (!limit && session.state === 'idle' && !moved) return undefined;
  return limit ? 'another-limit' : 'went-on';
}

/** What a look at a chat its limit still holds adds: when it was queued, for older jobs, and its latest refusal. */
function note(job: ScheduledContinuation, session: SessionInfo, now: number): boolean {
  let changed = false;
  // A job queued before its time was recorded counts from now, so no older reading speaks for it.
  if (job.scheduledAt === undefined) { job.scheduledAt = now; changed = true; }
  if (session.lastActivityAt > (job.activityAt ?? -Infinity)) { job.activityAt = session.lastActivityAt; changed = true; }
  if (!job.window && session.usageLimit?.window) { job.window = session.usageLimit.window; changed = true; }
  return changed;
}

/** Ends the continuations no longer wanted; their copies still undelivered are to be taken back from the relay. */
export function settle(state: LimitContinuationState, byId: Map<string, SessionInfo>, now: number,
  report: (limit: NamedLimit, release: Release) => void): { changed: boolean; takeBack: TakeBack[] } {
  let changed = false;
  const takeBack: TakeBack[] = [];
  for (const [sessionId, job] of Object.entries(state.scheduled)) {
    const session = byId.get(sessionId);
    const release = released(job, session, state.off.includes(sessionId), now);
    if (release === undefined) {
      if (session?.usageLimit?.resetsAt === job.resetsAt && note(job, session, now)) changed = true;
      continue;
    }
    takeBack.push({ scope: job.scope, ids: [job.regular, job.early]
      .flatMap(copy => copy && copy.deliveredAt === undefined ? [copy.messageId] : []) });
    delete state.scheduled[sessionId]; changed = true;
    report(named(sessionId, job), release);
  }
  for (const record of [state.tried ?? {}, state.continued ?? {}] as Record<string, number | { resetsAt: number }>[]) {
    for (const [sessionId, value] of Object.entries(record)) {
      if ((typeof value === 'number' ? value : value.resetsAt) > now - STALE_AFTER_RESET_MS) continue;
      delete record[sessionId]; changed = true;
    }
  }
  return { changed, takeBack };
}

/**
 * Records a job for every Claude chat a limit stopped that has none, due a minute after the reset. A chat
 * refused again for a reset whose continuation it was given waits a little more, so a provider whose
 * window opens late is not asked again every half minute.
 */
export function addJobs(state: LimitContinuationState, sessions: SessionInfo[], now: number,
  skipped: (limit: NamedLimit) => void): boolean {
  let changed = false;
  for (const session of sessions) {
    const limit = session.usageLimit, sessionId = session.sessionId;
    if (!limit || session.agent !== 'claude' || session.state !== 'idle' || state.scheduled[sessionId]) continue;
    if (limit.resetsAt <= now - STALE_AFTER_RESET_MS) continue;
    if (state.off.includes(sessionId)) { skipped({ sessionId, window: limit.window, resetsAt: limit.resetsAt }); continue; }
    const given = state.continued?.[sessionId];
    const notBefore = Math.max(now, limit.resetsAt + LIMIT_CONTINUE_GRACE_MS,
      given?.resetsAt === limit.resetsAt ? given.at + REFUSED_AGAIN_MS : 0);
    const chat: ContinuedChat = { sessionId, agent: session.agent, projectId: session.projectId, taskId: session.taskId,
      cwd: session.worktree ?? session.cwd };
    state.scheduled[sessionId] = { resetsAt: limit.resetsAt, ...(limit.window ? { window: limit.window } : {}),
      scope: continuationScope(chat), scheduledAt: now, activityAt: session.lastActivityAt,
      regular: continuationCopy(chat, limit.resetsAt, now, notBefore, false) };
    changed = true;
  }
  return changed;
}

/**
 * Records a second continuation, due at once, for a limited chat whose window the account's readings show has
 * room again before its reset. It is tried once per limit; the one due at the reset stays.
 */
export function continueEarly(state: LimitContinuationState, byId: Map<string, SessionInfo>, now: number,
  readings: UsageReadings): boolean {
  const waiting = Object.entries(state.scheduled).flatMap(([sessionId, job]) => {
    const session = byId.get(sessionId);
    // A job queued this moment has no reading taken after it yet.
    return session?.usageLimit?.resetsAt === job.resetsAt && job.scheduledAt !== undefined && job.scheduledAt < now
      && !job.early && state.tried?.[sessionId] !== job.resetsAt && now < job.resetsAt ? [{ sessionId, session, job }] : [];
  });
  if (!waiting.length) return false;
  let usage: ProviderAccountUsage[] = [], changed = false;
  // Unreadable limits only mean nothing goes early.
  try { usage = readings(); } catch { /* No readings. */ }
  for (const { sessionId, session, job } of waiting) {
    if (!limitLifted(session.usageLimit!, job.scheduledAt!, usage, now)) continue;
    job.early = continuationCopy(continuedChat(sessionId, job, session), job.resetsAt, now, now, true);
    (state.tried ??= {})[sessionId] = job.resetsAt;
    changed = true;
  }
  return changed;
}
