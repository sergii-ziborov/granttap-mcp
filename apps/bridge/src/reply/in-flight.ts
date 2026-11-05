import type { ReplyResult } from "./payload/types";

/**
 * Provider runs this runtime owns, keyed by the chat (or new-task key) they
 * were queued under. Kept apart from delivery so the session catalog can ask
 * whether a run is live without loading process control.
 */
const inFlight = new Map<string, Promise<ReplyResult | null>>();

export function isDeliveryInFlight(sessionId: string): boolean { return inFlight.has(sessionId); }

/** Acknowledging a message does not finish the provider turn or permit a runtime handoff. */
export function hasPendingDeliveries(): boolean { return inFlight.size > 0; }

/** One run per key at a time; the key stays live until the provider process settles. */
export function queued(key: string, run: () => Promise<ReplyResult>): Promise<ReplyResult> {
  const previous = inFlight.get(key) ?? Promise.resolve(null);
  const next = previous.then(run);
  const settled = next.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
  const tracked = settled.catch(() => null);
  inFlight.set(key, tracked);
  return settled;
}
