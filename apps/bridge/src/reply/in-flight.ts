import type { ReplyResult } from "./payload/types";

/**
 * Provider runs this runtime owns, keyed by the chat (or new-task key) they
 * were queued under. Kept apart from delivery so the session catalog can ask
 * whether a run is live without loading process control.
 */
const inFlight = new Map<string, Promise<ReplyResult | null>>();
const startedAt = new Map<string, number>();
/** Phone messages queued under a key that have not started yet: they wait in memory behind the run in progress. */
const waiting = new Map<string, number>();

export function isDeliveryInFlight(sessionId: string): boolean { return inFlight.has(sessionId); }

/** Acknowledging a message does not finish the provider turn or permit a runtime handoff. */
export function hasPendingDeliveries(): boolean { return inFlight.size > 0; }

/**
 * When the longest-running of those runs began; undefined when none is running. A runtime update that
 * waited for the runs to end and gave up uses it to tell whether the run it waited for is still going.
 */
export function oldestDeliveryStartedAt(): number | undefined {
  return startedAt.size ? Math.min(...startedAt.values()) : undefined;
}

/** The phone messages queued under `key` that start after the run in progress; read as a prompt is written. */
export function phoneMessagesWaiting(key: string): number { return waiting.get(key) ?? 0; }

/**
 * One run per key at a time; the key stays live until the provider process settles. A phone message
 * (`phone`) counts as waiting from the moment it is queued until its own run starts.
 */
export function queued(key: string, run: () => Promise<ReplyResult>, phone = false): Promise<ReplyResult> {
  const previous = inFlight.get(key) ?? Promise.resolve(null);
  if (!inFlight.has(key)) startedAt.set(key, Date.now());
  if (phone) waiting.set(key, phoneMessagesWaiting(key) + 1);
  const next = previous.then(() => {
    if (phone) {
      const left = phoneMessagesWaiting(key) - 1;
      if (left > 0) waiting.set(key, left); else waiting.delete(key);
    }
    return run();
  });
  const settled = next.finally(() => {
    if (inFlight.get(key) !== tracked) return;
    inFlight.delete(key);
    startedAt.delete(key);
  });
  const tracked = settled.catch(() => null);
  inFlight.set(key, tracked);
  return settled;
}
