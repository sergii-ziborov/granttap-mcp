import type { AutomationSchedule } from '../../../../../packages/protocol/schema';
import { parseCron, scanCalendar, type CalendarSets } from './cron';

export const HOUR_MS = 3_600_000;
const WEEKDAY_NUMBERS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 } as const;

function calendar(schedule: AutomationSchedule): CalendarSets | undefined {
  if (schedule.kind === 'cron') return parseCron(schedule.expression);
  if (schedule.kind !== 'daily') return undefined;
  const all = new Set(Array.from({ length: 31 }, (_, index) => index + 1));
  return { minutes: [schedule.minute], hours: [schedule.hour], days: all,
    months: new Set(Array.from({ length: 12 }, (_, index) => index + 1)),
    weekdays: new Set(schedule.weekdays.length ? schedule.weekdays.map(day => WEEKDAY_NUMBERS[day]) : [0, 1, 2, 3, 4, 5, 6]),
    anyDay: true, anyWeekday: true };
}

/** Why the computer cannot run this schedule from `now`, as the phone shows it; `undefined` when it can. */
export function scheduleProblem(schedule: AutomationSchedule, now: number): string | undefined {
  if (schedule.kind === 'once') return schedule.at > now ? undefined : 'Choose a time in the future.';
  if (schedule.kind === 'hours') return undefined;
  const sets = calendar(schedule);
  if (!sets) return 'Use five cron fields: minute, hour, day of month, month and weekday.';
  return scanCalendar(sets, now, 1) === undefined ? 'This schedule never runs.' : undefined;
}

/**
 * The first run strictly after `after`. `anchor` is when an every-N-hours schedule was saved or
 * resumed: it runs N hours after that, and every N hours from then. `undefined` when none is left.
 */
export function nextOccurrence(schedule: AutomationSchedule, after: number, anchor: number): number | undefined {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : undefined;
  if (schedule.kind === 'hours') {
    const period = schedule.every * HOUR_MS;
    return anchor + Math.max(1, Math.floor((after - anchor) / period) + 1) * period;
  }
  const sets = calendar(schedule);
  return sets && scanCalendar(sets, after, 1);
}

/** The latest run at or before `at`, after `anchor` for every-N-hours schedules. */
export function lastOccurrence(schedule: AutomationSchedule, at: number, anchor: number): number | undefined {
  if (schedule.kind === 'once') return schedule.at <= at ? schedule.at : undefined;
  if (schedule.kind === 'hours') {
    const period = schedule.every * HOUR_MS, count = Math.floor((at - anchor) / period);
    return count >= 1 ? anchor + count * period : undefined;
  }
  const sets = calendar(schedule);
  return sets && scanCalendar(sets, at, -1);
}

/** How many runs fall in `[from, to]`, counted up to `cap`. */
export function occurrencesBetween(schedule: AutomationSchedule, from: number, to: number, anchor: number,
  cap = 10_000): number {
  if (to < from) return 0;
  if (schedule.kind === 'hours') {
    const first = nextOccurrence(schedule, from - 1, anchor)!, period = schedule.every * HOUR_MS;
    return first > to ? 0 : Math.min(cap, Math.floor((to - first) / period) + 1);
  }
  let count = 0;
  for (let at = nextOccurrence(schedule, from - 1, anchor); at !== undefined && at <= to && count < cap;
    at = nextOccurrence(schedule, at, anchor)) count++;
  return count;
}
