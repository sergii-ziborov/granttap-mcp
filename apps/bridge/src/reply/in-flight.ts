import type { ReplyResult } from "./payload/types";
import { forgetDelivery, stalledDelivery, withinDelivery } from "./run-watch";
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

/** A new task's chat, and the new-task key its first run is queued under, while that run lasts. */
const firstRunOf = new Map<string, string>();

/** The first run of the new task whose chat this is, while it lasts. */
function firstRun(chatId: string): Promise<ReplyResult | null> | undefined {
  const key = firstRunOf.get(chatId);
  if (key === undefined) return undefined;
  const run = inFlight.get(key);
  if (!run) firstRunOf.delete(chatId);
  return run;
}

/**
 * A new task's first run is queued under the task's own key, yet the phone shows its chat, and can write
 * to it, as soon as the chat's id is known. From then until that run ends the chat counts as in flight and
 * a message to it waits for the run. Up to 0.8.205 such a message started a second provider process on the
 * same conversation while the first was still in a long command: the second found that command without a
 * result and told the person the session had broken off.
 */
export function chatRunsUnder(chatId: string, key: string): void {
  if (chatId && chatId !== key && inFlight.has(key)) firstRunOf.set(chatId, key);
}

export function isDeliveryInFlight(sessionId: string): boolean {
  return inFlight.has(sessionId) || firstRun(sessionId) !== undefined;
}

/** Acknowledging a message does not finish the provider turn or permit a runtime handoff. */
export function hasPendingDeliveries(): boolean { return inFlight.size > 0; }

/**
 * The keys whose work a newer monitor could not take over: anything but one run another monitor can
 * adopt, with nothing queued in memory behind it (`../survival`). Each with when its wait began. Work
 * whose provider process is gone, or that showed no sign of work for long (`run-watch.ts`), is left out:
 * it would hold the update until its deadline, hours away, and never ends in this monitor otherwise.
 */
export function blockingDeliveries(survivable: (key: string) => boolean = survivableKey,
  stalled: (key: string, since: number) => string | undefined = stalledDelivery): Array<{ key: string; since: number }> {
  return [...inFlight.keys()].filter(key => !(depth.get(key) === 1 && survivable(key)))
    .map(key => ({ key, since: startedAt.get(key) ?? Date.now() }))
    .filter(({ key, since }) => stalled(key, since) === undefined);
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
  const previous = inFlight.get(key) ?? firstRun(key) ?? Promise.resolve(null);
  if (!inFlight.has(key)) startedAt.set(key, since);
  depth.set(key, (depth.get(key) ?? 0) + 1);
  const settled = previous.then(() => withinDelivery(key, start)).finally(() => {
    const left = (depth.get(key) ?? 1) - 1;
    if (left > 0) depth.set(key, left); else depth.delete(key);
    if (inFlight.get(key) !== tracked) return;
    inFlight.delete(key);
    startedAt.delete(key);
    forgetDelivery(key);
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
