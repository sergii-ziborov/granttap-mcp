import type { ReplyResult } from "./payload/types";
import { currentSurvivor, survivableKey } from "./survival";

/**
 * Provider runs this runtime owns, keyed by the chat (or new-task key) they
 * were queued under. Kept apart from delivery so the session catalog can ask
 * whether a run is live without loading process control.
 */
const inFlight = new Map<string, Promise<ReplyResult | null>>();
const startedAt = new Map<string, number>();
/** Runs queued under a key and not settled yet, the one in progress included. */
const depth = new Map<string, number>();
/** Phone messages queued under a key that have not started yet: they wait in memory behind the run in progress. */
const waiting = new Map<string, number>();

export function isDeliveryInFlight(sessionId: string): boolean { return inFlight.has(sessionId); }

/** Acknowledging a message does not finish the provider turn or permit a runtime handoff. */
export function hasPendingDeliveries(): boolean { return inFlight.size > 0; }

/**
 * The keys whose work a newer monitor could not take over: anything but one run another monitor can
 * adopt, with nothing queued in memory behind it (`../survival`). Each with when its wait began.
 */
export function blockingDeliveries(survivable: (key: string) => boolean = survivableKey): Array<{ key: string; since: number }> {
  return [...inFlight.keys()].filter(key => !(depth.get(key) === 1 && survivable(key)))
    .map(key => ({ key, since: startedAt.get(key) ?? Date.now() }));
}

export function hasBlockingDeliveries(): boolean { return blockingDeliveries().length > 0; }

/**
 * When the longest-running of those runs began; undefined when none is running. A runtime update that
 * waited for the runs to end and gave up uses it to tell whether the run it waited for is still going.
 */
export function oldestDeliveryStartedAt(): number | undefined {
  return startedAt.size ? Math.min(...startedAt.values()) : undefined;
}

/** The same, among the runs a newer monitor could not take over. */
export function oldestBlockingDeliveryStartedAt(): number | undefined {
  const blocking = blockingDeliveries();
  return blocking.length ? Math.min(...blocking.map(item => item.since)) : undefined;
}

/** The phone messages queued under `key` that start after the run in progress; read as a prompt is written. */
export function phoneMessagesWaiting(key: string): number { return waiting.get(key) ?? 0; }

function enqueue(key: string, start: () => Promise<ReplyResult | null>, since = Date.now()): Promise<ReplyResult | null> {
  const previous = inFlight.get(key) ?? Promise.resolve(null);
  if (!inFlight.has(key)) startedAt.set(key, since);
  depth.set(key, (depth.get(key) ?? 0) + 1);
  const settled = previous.then(start).finally(() => {
    const left = (depth.get(key) ?? 1) - 1;
    if (left > 0) depth.set(key, left); else depth.delete(key);
    if (inFlight.get(key) !== tracked) return;
    inFlight.delete(key);
    startedAt.delete(key);
  });
  const tracked = settled.catch(() => null);
  inFlight.set(key, tracked);
  return settled;
}

/**
 * One run per key at a time; the key stays live until the provider process settles. A phone message
 * (`phone`) counts as waiting from the moment it is queued until its own run starts.
 */
export function queued(key: string, run: () => Promise<ReplyResult>, phone = false): Promise<ReplyResult> {
  if (phone) waiting.set(key, phoneMessagesWaiting(key) + 1);
  // The run is found by this key if another monitor takes it over.
  const handle = currentSurvivor();
  if (handle) handle.key ??= key;
  return enqueue(key, () => {
    if (phone) {
      const left = phoneMessagesWaiting(key) - 1;
      if (left > 0) waiting.set(key, left); else waiting.delete(key);
    }
    return run();
  }) as Promise<ReplyResult>;
}

/** A run this monitor took over from the one before holds its chat's key until it ends. */
export function holdKey(key: string, until: Promise<unknown>, since: number): void {
  void enqueue(key, () => until.then(() => null, () => null), since);
}
