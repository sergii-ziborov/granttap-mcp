import type { SessionInfo, UserMessage } from '../../../../packages/protocol/schema';
import { addJobs, continueEarly, continuedChat, named, released, settle, type NamedLimit, type Release,
  type TakeBack, type UsageReadings } from './holding';
import { logContinuation, logContinuationsFailure, logTime } from './log';
import { continuationCopy, failureReason, isLimitContinuation, putOnRelay, relayHolds,
  type ContinuationQueue } from './relay-copies';
import { readLimitContinuationState, writeLimitContinuationState, type ContinuationCopy, type LimitContinuationState,
  type ScheduledContinuation } from './store';

export { LIFT_BELOW_PERCENT, LIFT_READING_MAX_AGE_MS } from './lift';
export { LIMIT_CONTINUE_PROMPT, LIMIT_ROOM_PROMPT, type ContinuationQueue } from './relay-copies';
export { LIMIT_CONTINUE_GRACE_MS } from './store';
export type { UsageReadings } from './holding';

/** How often a copy on the relay is looked up: hourly while it waits, every five minutes once it is due. */
const LOOKUP_WAITING_MS = 3_600_000, LOOKUP_DUE_MS = 300_000;
const RELEASED: Record<Release, string> = { off: 'turned off on the phone', 'went-on': 'the chat went on',
  'another-limit': 'another limit stops the chat now', expired: 'the chat was not free to take it in the 7 days after the reset',
  done: 'it was delivered' };

/** What one monitor process remembers between catalogs: lookups, lines already logged, the pass running. */
type Memory = { lookedUp: Map<string, number>; logged: Set<string>; running?: Promise<void> };
/** One pass over a catalog: the relay queue it uses, its monitor's memory and the time it runs at. */
type Pass = { queue: ContinuationQueue; memory: Memory; now: number };
const memories = new WeakMap<ContinuationQueue, Memory>();
let registered: ContinuationQueue | undefined;

/** Only the persistent monitor owns the durable relay queue; session MCPs never schedule. */
export function registerLimitContinuationQueue(queue: ContinuationQueue | undefined): void { registered = queue; }

export function setAutoContinue(sessionId: string, enabled: boolean): void {
  update(state => {
    state.off = enabled ? state.off.filter(id => id !== sessionId) : [...state.off, sessionId];
    return true;
  });
}

/** Changes the saved state in one step: nothing else in this process runs between its read and its write. */
function update(change: (state: LimitContinuationState) => boolean): void {
  const state = readLimitContinuationState();
  if (change(state)) writeLimitContinuationState(state);
}

function savedState(): LimitContinuationState {
  try { return readLimitContinuationState(); } catch { return { off: [], scheduled: {} }; }
}

/**
 * The phone shows whether a limited chat will go on by itself; that is the default for Claude. Only
 * Claude chats are continued, so another agent's limited chat says it will not be.
 */
export function annotateLimitContinuations(sessions: SessionInfo[]): SessionInfo[] {
  if (!sessions.some(session => session.usageLimit)) return sessions;
  const off = new Set(savedState().off);
  return sessions.map(session => session.usageLimit ? { ...session, usageLimit: { ...session.usageLimit,
    autoContinue: session.agent === 'claude' && !off.has(session.sessionId) } } : session);
}

/**
 * For the chat itself: whether it goes on by itself after a subscription limit stopped it, and the
 * continuation waiting for it at one. `early` says a second one was queued to go at once because the
 * account's readings showed room before the reset. Read only.
 */
export function limitContinuationFor(sessionId: string): { autoContinue: boolean; continuation?: { dueAt: number; early: boolean } } {
  const state = savedState(), job = state.scheduled[sessionId];
  return { autoContinue: !state.off.includes(sessionId),
    ...(job ? { continuation: { dueAt: Math.max(job.scheduledAt ?? 0, job.regular.notBefore), early: !!job.early } } : {}) };
}

function memoryOf(queue: ContinuationQueue): Memory {
  let memory = memories.get(queue);
  if (!memory) memories.set(queue, memory = { lookedUp: new Map(), logged: new Set() });
  return memory;
}

function logOnce(memory: Memory, key: string, limit: NamedLimit, event: string): void {
  if (memory.logged.has(key)) return;
  memory.logged.add(key);
  logContinuation(limit, event);
}

/**
 * Keeps one "continue" waiting for every Claude chat its subscription stopped, due a minute after the reset,
 * and takes it back when the chat went on by itself or the person turned it off. The job is written down
 * here first and put on the relay after, so a failed upload, a restart or an update takeover leaves the
 * next pass the same copy to send. The relay holds it while this computer sleeps; a copy the relay no longer
 * holds is queued again under a new id. When the account's readings show room sooner, one more goes at once.
 */
export function scheduleLimitContinuations(sessions: SessionInfo[], queue = registered, now = Date.now(),
  readings: UsageReadings = () => []): Promise<void> {
  if (!queue) return Promise.resolve();
  const memory = memoryOf(queue);
  // A catalog comes every 30 s and a pass may wait on the relay; one pass at a time keeps one copy per limit.
  if (memory.running) return memory.running;
  const running = continuationPass(sessions, queue, memory, now, readings).catch(error => {
    const reason = failureReason(error);
    if (!memory.logged.has(`state:${reason}`)) { memory.logged.add(`state:${reason}`); logContinuationsFailure(reason); }
  }).finally(() => { memory.running = undefined; });
  memory.running = running;
  return running;
}

async function continuationPass(sessions: SessionInfo[], queue: ContinuationQueue, memory: Memory, now: number,
  readings: UsageReadings): Promise<void> {
  const byId = new Map(sessions.map(session => [session.sessionId, session]));
  let takeBack: TakeBack[] = [];
  update(state => {
    const settled = settle(state, byId, now, (limit, release) => {
      if (release !== 'done') logContinuation(limit, release === 'expired' ? `expired: ${RELEASED.expired}` : `taken back: ${RELEASED[release]}`);
    });
    takeBack = settled.takeBack;
    const added = addJobs(state, sessions, now, limit =>
      logOnce(memory, `off:${limit.sessionId}:${limit.resetsAt}`, limit, `skipped: ${RELEASED.off}`));
    return settled.changed || added;
  });
  for (const { scope, ids } of takeBack) for (const id of ids) await queue.cancel(scope, id).catch(() => {});
  update(state => continueEarly(state, byId, now, readings));
  const pass: Pass = { queue, memory, now };
  for (const [sessionId, job] of Object.entries(readLimitContinuationState().scheduled)) {
    for (const copy of [job.early, job.regular]) {
      if (!copy || copy.deliveredAt !== undefined) continue;
      if (!copy.onRelay) await send(pass, sessionId, job, copy);
      else if (copy === job.regular) await lookUp(pass, sessionId, job, byId.get(sessionId));
    }
  }
}

function copyIn(state: LimitContinuationState, sessionId: string, messageId: string | undefined): ContinuationCopy | undefined {
  const job = state.scheduled[sessionId];
  return job && [job.regular, job.early].find(copy => copy?.messageId === messageId);
}

async function send({ queue, memory, now }: Pass, sessionId: string, job: ScheduledContinuation,
  copy: ContinuationCopy): Promise<void> {
  const failure = await putOnRelay(queue, job.scope, copy);
  if (failure) {
    return logOnce(memory, `unsent:${copy.messageId}`, named(sessionId, job),
      `not on the relay yet (${failure}); it is tried again with the next catalog`);
  }
  memory.lookedUp.set(copy.messageId, now);
  let confirmed = false;
  update(state => {
    const saved = copyIn(state, sessionId, copy.messageId);
    if (saved && !saved.onRelay) saved.onRelay = confirmed = true;
    return confirmed;
  });
  if (confirmed) logContinuation(named(sessionId, job), copy === job.early
    ? "queued to go at once: the account's readings show room" : `queued, due ${logTime(copy.notBefore)}`);
}

/** Asks the relay, now and then, whether it still holds the copy due at the reset; queues a new one if not. */
async function lookUp(pass: Pass, sessionId: string, job: ScheduledContinuation, session: SessionInfo | undefined)
  : Promise<void> {
  const { queue, memory, now } = pass, copy = job.regular, last = memory.lookedUp.get(copy.messageId);
  if (last !== undefined && now >= last && now - last < (now >= copy.notBefore ? LOOKUP_DUE_MS : LOOKUP_WAITING_MS)) return;
  const held = await relayHolds(queue, job.scope, copy);
  if (!held) return;
  memory.lookedUp.set(copy.messageId, now);
  if (held.holds) return;
  let replacement: ContinuationCopy | undefined;
  update(state => {
    const current = state.scheduled[sessionId];
    if (current?.regular.messageId !== copy.messageId || current.regular.deliveredAt !== undefined) return false;
    replacement = current.regular = continuationCopy(continuedChat(sessionId, current, session), current.resetsAt, now,
      Math.max(now, copy.notBefore), false);
    return true;
  });
  if (!replacement) return;
  logContinuation(named(sessionId, job), `re-queued: the relay no longer held it (${held.state})`);
  await send(pass, sessionId, { ...job, regular: replacement }, replacement);
}

/**
 * Decides at delivery whether a continuation the relay hands back goes to the chat: only the copy its job
 * holds now, while the phone has not turned it off and, by `current` (the chat in the newest catalog), the
 * chat has not gone on since it was refused. One that goes is recorded and logged as delivered first.
 */
export function limitContinuationUnwanted(message: UserMessage, current?: () => SessionInfo | undefined,
  now = Date.now()): boolean {
  if (!isLimitContinuation(message)) return false;
  const sessionId = message.sessionId!, session = current?.();
  let refusal: string | undefined, delivered: { job: ScheduledContinuation; early: boolean } | undefined;
  try {
    update(state => {
      const job = state.scheduled[sessionId], copy = copyIn(state, sessionId, message.messageId);
      const release = job && session ? released(job, session, false, now) : undefined;
      refusal = state.off.includes(sessionId) ? RELEASED.off : !job || !copy ? 'a newer copy replaced it, or the chat went on'
        : release !== undefined && copy.deliveredAt === undefined ? RELEASED[release] : undefined;
      if (refusal || copy!.deliveredAt !== undefined) return false;
      copy!.deliveredAt = now;
      if (copy === job!.regular) (state.continued ??= {})[sessionId] = { resetsAt: job!.resetsAt, at: now };
      delivered = { job: job!, early: copy !== job!.regular };
      return true;
    });
  } catch (error) { refusal = `its state could not be read or saved (${failureReason(error)})`; }
  const job = delivered?.job ?? savedState().scheduled[sessionId];
  const limit = job ? named(sessionId, job) : { sessionId };
  if (refusal) logContinuation(limit, `skipped at delivery: ${refusal}`);
  else if (delivered) {
    const after = Math.round((now - delivered.job.resetsAt) / 60_000);
    logContinuation(limit, delivered.early ? "delivered early: the account's readings showed room"
      : `delivered${after > 0 ? `, ${after} min after the reset` : ''}`);
  }
  return refusal !== undefined;
}
