import type { SessionInfo } from '../../../../packages/protocol/schema';
import { LIMIT_CONTINUE_GRACE_MS, REFUSED_AGAIN_MS } from '../limit-continuation';

/** A chat refused by its limit is tried again this long after its latest refusal, unless its reset is later. */
export const RETRY_AFTER_REFUSAL_MS = REFUSED_AGAIN_MS;
/** Queued messages wait this long past their continuation's time for it to arrive; then they go without it. */
export const CONTINUATION_FIRST_MS = 10 * 60_000;

/** The usage limit the chat's newest turn was refused by, with its reset when the provider said it. */
export type ChatLimit = { resetsAt?: number; window?: string; refusedAt: number };
export type HoldReason = 'reset' | 'continuation' | 'refused-again' | 'unknown-reset';
/** Why queued messages may go: `trying` and `continued` mean one already went since the refusal. */
export type Release = 'went-on' | 'trying' | 'continued' | 'reset' | 'readings' | 'retry' | 'late-continuation';
/** `until` is the time the phone shows: the reset, or the next try. */
export type QueueDecision = { hold: HoldReason; until: number; limit: ChatLimit } | { release: Release; limit?: ChatLimit };

/** The chat's continuation, as `continuationAhead` reads it. */
export type ContinuationAhead = { resetsAt?: number; dueAt?: number; deliveredAt?: number };

export type DecisionInput = {
  session: SessionInfo;
  now: number;
  /** When this computer last let a queued message go to the chat while its limit showed. */
  triedAt?: number;
  ahead: ContinuationAhead;
  /** Whether a reading taken after `since` shows the limit's window has room. */
  room: (limit: ChatLimit, since: number) => boolean;
};

/**
 * The limit a chat's queued messages wait for: a current `usageLimit`, or a turn stopped by one whose reset
 * the provider did not say (Codex without "try again at"). Claude publishes its limit until an hour after the
 * reset; the refusal's time is the chat's last activity, which is the refusal.
 */
export function chatLimit(session: SessionInfo): ChatLimit | undefined {
  const { usageLimit, stopped } = session;
  if (usageLimit) {
    return { resetsAt: usageLimit.resetsAt, ...(usageLimit.window ? { window: usageLimit.window } : {}),
      refusedAt: stopped?.reason === 'usage_limit' ? stopped.at : session.lastActivityAt };
  }
  return stopped?.reason === 'usage_limit' ? { refusedAt: stopped.at } : undefined;
}

const held = (hold: HoldReason, until: number, limit: ChatLimit): QueueDecision => ({ hold, until, limit });

/**
 * Whether a chat's queued phone messages wait for its usage limit. They wait for the reset, then behind the
 * chat's continuation while it is due; one goes after that. Refused again, the chat waits a quarter of an hour
 * from that refusal, or until a later reset, before the next try: one try at a time, never a burst.
 * A limit with no known reset waits for a reading that shows room, or a quarter of an hour.
 */
export function queueDecision(input: DecisionInput): QueueDecision {
  const { session, now, ahead, room } = input, limit = chatLimit(session);
  if (!limit) return { release: 'went-on' };
  const lastTry = Math.max(input.triedAt ?? -Infinity, ahead.deliveredAt ?? -Infinity);
  // Something went to the chat since this refusal and has not been refused yet: the chat's run decides.
  if (lastTry >= limit.refusedAt) {
    return { release: (ahead.deliveredAt ?? -Infinity) >= limit.refusedAt ? 'continued' : 'trying', limit };
  }
  const continuing = limit.resetsAt !== undefined && ahead.resetsAt === limit.resetsAt;
  const due = continuing ? ahead.dueAt : undefined;
  // The continuation is the chat's first try once its limit lets it go; the queued messages follow it.
  if (due !== undefined && due <= now) {
    return now < due + CONTINUATION_FIRST_MS ? held('continuation', due, limit) : { release: 'late-continuation', limit };
  }
  const reset = limit.resetsAt === undefined ? undefined : limit.resetsAt + LIMIT_CONTINUE_GRACE_MS;
  const retry = limit.refusedAt + RETRY_AFTER_REFUSAL_MS;
  if (lastTry > -Infinity) {
    // Refused again after a try. A reading does not shorten this wait: readings lag, and trusting one
    // that the provider contradicts would try again with every new reading.
    if (reset !== undefined && reset > retry) {
      return now < reset ? held('refused-again', limit.resetsAt!, limit) : { release: 'reset', limit };
    }
    return now < retry ? held('refused-again', retry, limit) : { release: 'retry', limit };
  }
  if (reset !== undefined) {
    if (now >= reset) return { release: 'reset', limit };
    // With a continuation waiting, its own early copy is what goes when a reading shows room.
    return !continuing && room(limit, limit.refusedAt) ? { release: 'readings', limit } : held('reset', limit.resetsAt!, limit);
  }
  if (now >= retry) return { release: 'retry', limit };
  return room(limit, limit.refusedAt) ? { release: 'readings', limit } : held('unknown-reset', retry, limit);
}
