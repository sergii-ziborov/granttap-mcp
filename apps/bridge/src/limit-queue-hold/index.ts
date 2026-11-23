import type { ProviderAccountUsage, SessionInfo, TaskDispatch } from '../../../../packages/protocol/schema';
import { continuationAhead, isLimitContinuation } from '../limit-continuation';
import { cachedNativeAccountUsage } from '../provider-account-status';
import { chatLimit, queueDecision, type QueueDecision } from './decision';
import { logQueueHeld, logQueueHoldFailure, logQueueReleased } from './log';
import { readingsShowRoom } from './readings';
import { readLimitQueueState, writeLimitQueueState, type HeldChat, type LimitQueueState } from './store';

export { CONTINUATION_FIRST_MS, RETRY_AFTER_REFUSAL_MS, chatLimit, queueDecision, type QueueDecision } from './decision';

/** The account's limit readings, read only when a held chat could go before its reset or has none. */
export type UsageReadings = () => ProviderAccountUsage[];

/** Failures already logged by this process; a disk that keeps failing logs once. */
const failures = new Set<string>();

/**
 * A queued job a usage limit can hold: a phone message to an existing chat that waits its turn. Send now
 * (`immediate`), a new task and the chat's own limit continuation go as before.
 */
export function limitCanHold(job: TaskDispatch): boolean {
  const operation = job.operation;
  return operation.type === 'user.message' && !!job.sessionId && job.deliveryMode !== 'immediate'
    && !isLimitContinuation(operation);
}

function decide(session: SessionInfo, now: number, chat: HeldChat | undefined, readings: UsageReadings,
  ahead = continuationAhead(session.sessionId)): QueueDecision {
  let usage: ProviderAccountUsage[] | undefined;
  return queueDecision({ session, now, triedAt: chat?.triedAt, ahead,
    room: (limit, since) => {
      // Unreadable readings only mean nothing goes before its time.
      if (!usage) { try { usage = readings(); } catch { usage = []; } }
      return readingsShowRoom(session.agent, limit, since, usage, now);
    } });
}

/**
 * What this decision changes in the chat's record, logging the start and the end of a hold. Returns the new
 * record, `null` to forget the chat, or `undefined` when nothing changed. A try (a message let go while the
 * limit still shows) is recorded, so a refusal after it counts as a refusal again, across restarts too.
 */
function recorded(chat: HeldChat | undefined, decision: QueueDecision, session: SessionInfo, now: number,
  continuedAt = -Infinity): HeldChat | null | undefined {
  const sessionId = session.sessionId;
  if ('hold' in decision) {
    if (chat?.held) return undefined;
    logQueueHeld(sessionId, decision.limit, decision.hold, decision.until);
    return { ...chat, held: { reason: decision.hold, since: now }, seenAt: now };
  }
  const { release, limit } = decision, { held: _held, ...rest }: HeldChat = chat ?? { seenAt: now };
  const tries = !['went-on', 'trying', 'continued'].includes(release);
  // A chat that shows no limit while its continuation runs went on because of that continuation.
  const why = release === 'went-on' && continuedAt >= (chat?.held?.since ?? Infinity) ? 'continued' : release;
  if (chat?.held || tries) logQueueReleased(sessionId, limit, why);
  // A chat whose turn ended without a limit went on; one still working may yet be refused.
  if (release === 'went-on' && session.state === 'idle') return chat ? null : undefined;
  if (tries) return { ...rest, triedAt: now, seenAt: now };
  return chat?.held ? { ...rest, seenAt: now } : undefined;
}

/**
 * Whether a usage limit holds the queued phone messages of one chat now; the task-dispatch worker asks before
 * it looks at one of them. `session` is the chat as the newest catalog and its native tail show it. They stay
 * queued, neither started nor refused, until the decision lets one go (`decision.ts`).
 */
export function queueHeldByLimit(sessionId: string, session: SessionInfo | undefined, now = Date.now(),
  readings: UsageReadings = cachedNativeAccountUsage): boolean {
  if (!session) return false;
  let state: LimitQueueState | undefined;
  try { state = readLimitQueueState(); } catch (error) { logFailure(error); }
  const chat = state?.chats[sessionId];
  // A chat without a limit and nothing recorded for it, such as one that is only busy: nothing to hold or end.
  if (!chat && !chatLimit(session)) return false;
  const ahead = continuationAhead(sessionId);
  const decision = decide(session, now, chat, readings, ahead);
  const next = recorded(chat, decision, session, now, ahead.deliveredAt);
  if (state && next !== undefined) {
    if (next === null) delete state.chats[sessionId]; else state.chats[sessionId] = next;
    try { writeLimitQueueState(state, now); } catch (error) { logFailure(error); }
  }
  return 'hold' in decision;
}

function logFailure(error: unknown): void {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 120);
  if (failures.has(reason)) return;
  failures.add(reason);
  logQueueHoldFailure(reason);
}

/**
 * For the phone: each chat whose queued messages a usage limit holds says until when (`queueHold`), the
 * reset or the next try, so its queue can say they wait for the limit and the composer queues new ones.
 * Read only.
 */
export function annotateQueueHolds(sessions: SessionInfo[], now = Date.now(),
  readings: UsageReadings = cachedNativeAccountUsage): SessionInfo[] {
  if (!sessions.some(session => chatLimit(session))) return sessions;
  let state: LimitQueueState = { chats: {} };
  try { state = readLimitQueueState(); } catch { /* Holds are then decided without what was tried. */ }
  return sessions.map(session => {
    if (!chatLimit(session)) return session;
    const decision = decide(session, now, state.chats[session.sessionId], readings);
    return 'hold' in decision ? { ...session, queueHold: { reason: 'usage_limit' as const, until: Math.round(decision.until) } }
      : session;
  });
}
