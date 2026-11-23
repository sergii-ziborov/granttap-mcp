import type { SessionCompaction, SessionInfo, SessionsStatus } from '../../../../packages/protocol/schema';
import { compactCodexSession } from '../providers/codex-control';
import { isDeliveryInFlight, phoneMessagesWaiting, queued } from '../reply/in-flight';
import { runningProcessCount } from '../reply/process';
import { tokenScale } from '../sessions/context-usage/compactions';
import { compactClaudeSession, type CompactOutcome } from './claude';
import { savedCompactionState, updateCompactionState, type CompactionRun, type CompactionState } from './store';
import { autoCompactDue, claudeSessionHeld, DEFAULT_AUTO_COMPACT_TOKENS } from './trigger';

export { readClaudeCompaction, type CompactOutcome } from './claude';
export { AUTO_COMPACT_QUIET_MS, AUTO_COMPACT_RECENT_MS, autoCompactDue, DEFAULT_AUTO_COMPACT_TOKENS } from './trigger';

/** A Codex or Claude record of a run lands this long after the run itself ends, at most. */
const RECORD_LAG_MS = 10_000;
/** Chats this monitor is compacting now. */
const running = new Set<string>();
let automatic: Promise<void> | undefined;

const providerName = (agent: string) => agent === 'claude' ? 'Claude Code' : 'Codex';
const compactable = (session: SessionInfo) => session.agent === 'claude' || session.agent === 'codex';

/** The threshold in force for a chat: the one set for it, `0` for off, or the provider's default. */
export function autoCompactThreshold(session: Pick<SessionInfo, 'sessionId' | 'agent'>,
  state: CompactionState = savedCompactionState()): { atTokens?: number; isDefault: boolean } {
  const set = state.thresholds[session.sessionId];
  if (set === 0) return { isDefault: false };
  if (set) return { atTokens: set, isDefault: false };
  const fallback = DEFAULT_AUTO_COMPACT_TOKENS[session.agent];
  return fallback ? { atTokens: fallback, isDefault: true } : { isDefault: true };
}

/** From the phone: off, a threshold, or back to the provider's default. */
export function setAutoCompact(sessionId: string, enabled: boolean, atTokens?: number): void {
  updateCompactionState((state) => {
    if (!enabled) state.thresholds[sessionId] = 0;
    else if (atTokens) state.thresholds[sessionId] = atTokens;
    else delete state.thresholds[sessionId];
  });
}

/** Why the chat cannot be compacted now, in words for the phone; undefined when it can. */
function busyReason(session: SessionInfo): string | undefined {
  const name = providerName(session.agent);
  if (running.has(session.sessionId)) return 'This chat is already being compacted.';
  if (session.state === 'working') return `Wait for the active ${name} turn to finish before compacting it.`;
  if (isDeliveryInFlight(session.sessionId) || runningProcessCount(session.sessionId) > 0
    || phoneMessagesWaiting(session.sessionId) > 0) {
    return `A turn GrantTap started in this chat is still running; compact it after the turn ends.`;
  }
  if (session.agent === 'claude' && claudeSessionHeld(session.sessionId)) {
    return 'This chat is open in Claude Code on the computer. Type /compact there, or close it there and compact it from here.';
  }
  return undefined;
}

function record(sessionId: string, run: CompactionRun): void {
  try {
    updateCompactionState((state) => { state.runs[sessionId] = [...(state.runs[sessionId] ?? []), run]; });
  } catch { /* An unreadable state keeps what it holds; the transcript still records the compaction. */ }
}

/**
 * Compacts one chat with its provider's own command: Claude Code's `/compact`, Codex's app-server
 * compaction. Only between turns: never while a turn runs, a GrantTap run or queued message waits for
 * the chat, or a Claude Code open on the computer holds it. Runs under the chat's delivery key, so a
 * message that arrives meanwhile waits for it. The run is recorded so the phone can say who did it.
 */
export async function compactChat(session: SessionInfo, by: CompactionRun['by']): Promise<CompactOutcome> {
  if (!compactable(session)) return { ok: false, error: `${session.agent} has no compaction GrantTap can run.`, refused: true };
  const busy = busyReason(session);
  if (busy) return { ok: false, error: busy, refused: true };
  running.add(session.sessionId);
  const startedAt = Date.now(), before = session.contextUsage?.usedTokens;
  try {
    let outcome = { ok: false, error: 'The compaction did not run.' } as CompactOutcome;
    await queued(session.sessionId, async () => {
      outcome = session.agent === 'claude' ? await compactClaudeSession(session)
        : await compactCodexSession(session.sessionId).then((result): CompactOutcome => result.ok
          ? { ok: true, ...(before != null ? { preTokens: before } : {}) } : result);
      return outcome.ok ? { ok: true, text: '' } : { ok: false, error: outcome.error };
    });
    record(session.sessionId, { by, startedAt, endedAt: Date.now(), ok: outcome.ok,
      ...(outcome.ok ? { ...(outcome.preTokens != null ? { preTokens: outcome.preTokens } : {}),
        ...(outcome.postTokens != null ? { postTokens: outcome.postTokens } : {}) } : { error: outcome.error.slice(0, 300) }) });
    return outcome;
  } finally {
    running.delete(session.sessionId);
  }
}

/** The words the phone shows for a finished compaction. */
export function compactedText(session: SessionInfo, outcome: CompactOutcome): string {
  if (!outcome.ok) return outcome.refused ? outcome.error : `Context compaction failed: ${outcome.error}`;
  if (session.agent === 'codex') return 'Codex context compaction completed.';
  const size = outcome.preTokens != null && outcome.postTokens != null
    ? `: ${tokenScale(outcome.preTokens)} → ${tokenScale(outcome.postTokens)} tokens` : '';
  return `Claude Code compacted the context${size}. The chat continues from its summary.`;
}

/**
 * The provider's newest compaction, said to be GrantTap's when one of this computer's runs made it;
 * a run the transcript does not show yet stands in for it and is counted.
 */
function attributed(seen: Pick<SessionCompaction, 'count' | 'last'>, runs: CompactionRun[]): Pick<SessionCompaction, 'count' | 'last'> {
  const ours = runs.filter((run) => run.ok);
  const last = seen.last;
  const made = last && ours.find((run) => last.at >= run.startedAt && last.at <= run.endedAt + RECORD_LAG_MS);
  if (last && made) {
    return { count: seen.count, last: { preTokens: made.preTokens, postTokens: made.postTokens, ...last, trigger: made.by } };
  }
  const newer = ours.at(-1);
  if (!newer || newer.endedAt <= (last?.at ?? 0)) return seen;
  return { count: seen.count + 1, last: { at: newer.endedAt, trigger: newer.by,
    ...(newer.preTokens != null ? { preTokens: newer.preTokens } : {}),
    ...(newer.postTokens != null ? { postTokens: newer.postTokens } : {}) } };
}

function annotated(session: SessionInfo, state: CompactionState): SessionInfo {
  if (!compactable(session)) return session;
  const seen = attributed(session.compaction ?? { count: 0 }, state.runs[session.sessionId] ?? []);
  const { atTokens, isDefault } = autoCompactThreshold(session, state);
  const last = seen.last && Object.fromEntries(Object.entries(seen.last).filter(([, value]) => value !== undefined));
  return { ...session, compaction: { count: seen.count, ...(last ? { last: last as SessionCompaction['last'] } : {}),
    ...(atTokens ? { autoAtTokens: atTokens } : {}), autoAtDefault: isDefault,
    ...(running.has(session.sessionId) ? { running: true } : {}) } };
}

/** Every Claude and Codex chat in a catalog says how often it was compacted and when GrantTap compacts it. */
export function annotateCompactionCatalog<T extends Pick<SessionsStatus, 'sessions' | 'history'>>(status: T): T {
  const state = savedCompactionState();
  return { ...status, sessions: status.sessions.map((session) => annotated(session, state)),
    ...(status.history ? { history: status.history.map((session) => annotated(session, state)) } : {}) };
}

function log(session: SessionInfo, text: string): void {
  process.stderr.write(`[monitor] context compaction of ${session.agent} chat ${session.sessionId.slice(0, 8)}: ${text}\n`);
}

async function compactWhenDue(sessions: SessionInfo[], now: number): Promise<void> {
  const state = savedCompactionState();
  // Whether something holds the chat is asked last: it reads Claude's list of running sessions.
  const due = sessions.filter((session) => compactable(session) && !/^transfer-/.test(session.sessionId)
    && autoCompactDue(session, { now, atTokens: autoCompactThreshold(session, state).atTokens,
      triedReading: state.triedReading?.[session.sessionId], busy: false }))
    .find((session) => busyReason(session) === undefined);
  if (!due?.contextUsage) return;
  const reading = due.contextUsage.observedAt, at = autoCompactThreshold(due, state).atTokens!;
  updateCompactionState((saved) => { saved.triedReading = { ...saved.triedReading, [due.sessionId]: reading }; });
  log(due, `${tokenScale(due.contextUsage.usedTokens)} tokens reached its ${tokenScale(at)} threshold between turns`);
  const outcome = await compactChat(due, 'threshold');
  log(due, outcome.ok ? compactedText(due, outcome) : `not compacted: ${outcome.error}`);
}

/**
 * Looks at each catalog for a chat that reached its threshold since its last turn and compacts it, one
 * chat at a time across this computer. A reading is tried once: a refusal waits for the next turn.
 */
export function scheduleAutoCompactions(sessions: SessionInfo[], now = Date.now()): Promise<void> {
  if (automatic) return automatic;
  automatic = compactWhenDue(sessions, now)
    .catch((error) => { process.stderr.write(`[monitor] context compaction pass failed: ${String(error).slice(0, 200)}\n`); })
    .finally(() => { automatic = undefined; });
  return automatic;
}
