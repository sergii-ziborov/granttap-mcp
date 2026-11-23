import type { CodingAgent, ProviderAccountUsage, SessionInfo } from '../../../../../packages/protocol/schema';
import { LIFT_BELOW_PERCENT, LIFT_READING_MAX_AGE_MS, LIMIT_CONTINUE_GRACE_MS } from '../../limit-continuation';
import type { ChatHold } from './plan';

/** Catalogs come every 30 s; one older than this says nothing about whether the chat is working now. */
export const FRESH_CATALOG_MS = 60_000;

/** What the monitor knows about one chat when a run of it is due. */
export type ChatSnapshot = {
  agent: CodingAgent;
  /** The chat in the newest catalog, its native tail looked at; absent when the catalog does not list it. */
  session?: SessionInfo;
  catalogAt?: number;
  /** A run of this monitor is in progress in the chat. */
  inFlight: boolean;
  /** Held from the phone. */
  paused: boolean;
  /** Phone messages waiting for the chat, in the durable queue or in memory. They go first. */
  queued: number;
  /** A runtime update drains the monitor: nothing new starts. */
  updating: boolean;
  /** A continuation after the chat's usage limit waits for it; it goes first. */
  continuation: boolean;
  readings: ProviderAccountUsage[];
};

/**
 * When the chat's usage limit lets it work again, or `undefined` when nothing limits it. The same signals
 * the limit continuation reads: the chat's own refusal (`usageLimit`, a minute's grace past its reset), and
 * for the account as a whole a recent reading of the agent's account-wide window at or above
 * `LIFT_BELOW_PERCENT` that has not reset. A per-model limit does not hold another model's chat.
 */
export function limitHold(agent: CodingAgent, session: SessionInfo | undefined, readings: ProviderAccountUsage[],
  now: number): number | undefined {
  let until: number | undefined;
  const refusal = session?.usageLimit;
  if (refusal && now < refusal.resetsAt + LIMIT_CONTINUE_GRACE_MS) until = refusal.resetsAt + LIMIT_CONTINUE_GRACE_MS;
  for (const report of readings) {
    if (report.provider !== agent || report.label || now - report.observedAt > LIFT_READING_MAX_AGE_MS) continue;
    for (const window of report.windows) {
      if (window.usedPercent < LIFT_BELOW_PERCENT || window.resetsAt <= now) continue;
      until = Math.max(until ?? 0, window.resetsAt + LIMIT_CONTINUE_GRACE_MS);
    }
  }
  return until;
}

/**
 * Why a due run cannot go into its chat now, or `undefined` when the chat is free: listed idle in a fresh
 * catalog with no run, background work or phone message ahead of it, not paused, not held by a usage limit
 * and with no limit continuation waiting. A fresh catalog without the chat lets delivery decide: it refuses
 * a chat that is gone instead of waiting for it forever.
 */
export function chatHold(chat: ChatSnapshot, now: number): ChatHold | undefined {
  if (chat.updating) return { reason: 'update' };
  if (chat.catalogAt === undefined || Math.abs(now - chat.catalogAt) > FRESH_CATALOG_MS) return { reason: 'checking' };
  const session = chat.session;
  if (chat.paused || session?.paused) return { reason: 'paused' };
  if (chat.inFlight || session && (session.state !== 'idle' || session.backgroundTasks)) return { reason: 'busy' };
  if (chat.queued > 0) return { reason: 'queued' };
  const until = limitHold(chat.agent, session, chat.readings, now);
  if (until !== undefined) return { reason: 'limit', until };
  if (chat.continuation) return { reason: 'continuation' };
  return undefined;
}
