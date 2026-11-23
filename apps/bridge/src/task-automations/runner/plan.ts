import { HOUR_MS, lastOccurrence, nextOccurrence, occurrencesBetween } from '../cadence';
import { automationLine } from '../log';
import type { AutomationState, StoredAutomation } from '../store';

/** A run found due more than this long after its time, because the computer slept or was off, is skipped. */
export const CATCH_UP_MS = 12 * HOUR_MS;
/** A run with no later one to give way to (one-time, Run now) waits this long, past Claude's weekly limit. */
export const LONGEST_WAIT_MS = 7 * 24 * HOUR_MS + 2 * HOUR_MS;

/** Why the chat cannot take a run now; `until` when that is known, such as a usage limit's reset. */
export type ChatHold = { reason: string; until?: number };
/** A run this pass hands to the chat, recorded as ran before it is delivered. */
export type ClaimedRun = { row: StoredAutomation; dueAt: number; manual: boolean };
export type Plan = { changed: boolean; runs: ClaimedRun[]; lines: string[] };

const ASLEEP = 'The computer was asleep or GrantTap was not running when it was due.';
const GAVE_WAY: Record<string, string> = {
  limit: 'The usage limit had not reset by the next run.',
  paused: 'The chat was paused from the phone until the next run.',
  continuation: 'The chat was still continuing after its usage limit at the next run.',
};
const NOT_FREE = 'The chat was not free until the next run.';
const WAITED_TOO_LONG = 'The chat was not free in the 7 days after it was due.';

function skip(row: StoredAutomation, now: number, lines: string[],
  skipped: { dueAt: number; reason: string; count?: number; manual?: boolean }): void {
  const count = skipped.count !== undefined && skipped.count > 1 ? Math.min(skipped.count, 10_000) : undefined;
  row.last = { at: now, outcome: 'skipped', dueAt: skipped.dueAt, ...(count ? { count } : {}),
    ...(skipped.manual ? { manual: true } : {}), reason: skipped.reason };
  lines.push(automationLine(row, `skipped${count ? ` ${count} runs` : ''}`, skipped.dueAt, skipped.reason));
}

function dropPending(row: StoredAutomation): void { delete row.pending; delete row.waiting; }

/**
 * Takes up the scheduled runs that came due. Only the latest is kept: runs missed while the computer slept
 * are skipped in one line, and the latest too when it is more than `CATCH_UP_MS` late. A run still waiting
 * for its chat gives way to the next one (a Run now still waiting is kept and counts as it).
 */
function takeDue(row: StoredAutomation, now: number, lines: string[]): boolean {
  if (row.status !== 'ACTIVE' || row.nextRunAt === undefined || row.nextRunAt > now) return false;
  const first = row.nextRunAt;
  const latest = Math.max(first, lastOccurrence(row.schedule, now, row.anchorAt) ?? first);
  const missed = latest > first ? occurrencesBetween(row.schedule, first, latest - 1, row.anchorAt) : 0;
  const manual = !!row.pending?.manual;
  if (row.pending && !manual) {
    skip(row, now, lines, { dueAt: row.pending.dueAt, reason: GAVE_WAY[row.waiting?.reason ?? ''] ?? NOT_FREE });
    dropPending(row);
  }
  const late = now - latest > CATCH_UP_MS;
  if (missed > 0 || late) {
    skip(row, now, lines, { dueAt: late ? latest : first, count: missed + (late ? 1 : 0), reason: ASLEEP });
  }
  if (!late) row.pending = { dueAt: latest, since: row.pending?.since ?? now, ...(manual ? { manual: true } : {}) };
  const next = nextOccurrence(row.schedule, latest, row.anchorAt);
  if (next === undefined) delete row.nextRunAt; else row.nextRunAt = next;
  return true;
}

/** A waiting run that no later run will replace is given up after `LONGEST_WAIT_MS`. */
function expire(row: StoredAutomation, now: number, lines: string[]): boolean {
  const pending = row.pending;
  if (!pending || now - pending.since <= LONGEST_WAIT_MS) return false;
  if (!pending.manual && row.status === 'ACTIVE' && row.nextRunAt !== undefined) return false;
  skip(row, now, lines, { dueAt: pending.dueAt, reason: WAITED_TOO_LONG, manual: pending.manual });
  dropPending(row);
  return true;
}

function sameHold(row: StoredAutomation, hold: ChatHold): boolean {
  return row.waiting?.reason === hold.reason && row.waiting.until === hold.until;
}

/**
 * One pass over the saved automations at `now`: due runs are taken up, and each waiting run either waits
 * (with why) or is claimed for its chat. One run per chat per pass; the next waits until the chat is free.
 */
export function planAutomations(state: AutomationState, now: number, hold: (row: StoredAutomation) => ChatHold | undefined,
  delivering: ReadonlySet<string> = new Set()): Plan {
  const plan: Plan = { changed: false, runs: [], lines: [] }, claimedChats = new Set<string>();
  for (const row of state.automations) {
    if (takeDue(row, now, plan.lines)) plan.changed = true;
    if (expire(row, now, plan.lines)) plan.changed = true;
    const pending = row.pending;
    if (!pending) continue;
    const reason = claimedChats.has(row.sessionId) || delivering.has(row.sessionId)
      ? { reason: 'busy' } : hold(row);
    if (reason) {
      if (!sameHold(row, reason)) {
        row.waiting = { reason: reason.reason, ...(reason.until === undefined ? {} : { until: reason.until }) };
        plan.changed = true;
      }
      continue;
    }
    claimedChats.add(row.sessionId);
    row.last = { at: now, outcome: 'ran', dueAt: pending.dueAt, ...(pending.manual ? { manual: true } : {}) };
    dropPending(row);
    plan.runs.push({ row, dueAt: pending.dueAt, manual: !!pending.manual });
    plan.changed = true;
  }
  return plan;
}
