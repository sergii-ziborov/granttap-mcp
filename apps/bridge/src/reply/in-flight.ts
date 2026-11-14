import type { ReplyResult } from "./payload/types";

/**
 * Provider runs this runtime owns, keyed by the chat (or new-task key) they
 * were queued under. Kept apart from delivery so the session catalog can ask
 * whether a run is live without loading process control.
 */
const inFlight = new Map<string, Promise<ReplyResult | null>>();
const startedAt = new Map<string, number>();

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

/** One run per key at a time; the key stays live until the provider process settles. */
export function queued(key: string, run: () => Promise<ReplyResult>): Promise<ReplyResult> {
  const previous = inFlight.get(key) ?? Promise.resolve(null);
  if (!inFlight.has(key)) startedAt.set(key, Date.now());
  const next = previous.then(run);
  const settled = next.finally(() => {
    if (inFlight.get(key) !== tracked) return;
    inFlight.delete(key);
    startedAt.delete(key);
  });
  const tracked = settled.catch(() => null);
  inFlight.set(key, tracked);
  return settled;
}
