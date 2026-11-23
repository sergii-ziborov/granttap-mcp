/** Minutes, hours, days, months and weekdays a schedule allows, in the computer's local time. */
export type CalendarSets = {
  minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number>;
  /** A field written `*`: cron then needs both day fields to match, otherwise either one. */
  anyDay: boolean; anyWeekday: boolean;
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** Long enough for a schedule that only February 29 satisfies. */
const SEARCH_DAYS = 5 * 366 + 1;

type Field = { min: number; max: number; names?: string[]; offset?: number };
const FIELDS: Field[] = [{ min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS, offset: 1 }, { min: 0, max: 7, names: WEEKDAYS }];

function value(text: string, field: Field): number | undefined {
  const named = field.names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0) return named + (field.offset ?? 0);
  if (!/^\d{1,2}$/.test(text)) return undefined;
  const number = Number(text);
  return number >= field.min && number <= field.max ? number : undefined;
}

/** One field: `*`, a value, a range, any of those with `/step`, or a comma list of them. */
function parseField(text: string, field: Field): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return undefined;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1) return undefined;
    let low = field.min, high = field.max;
    if (match[1] !== '*') {
      const [from, to] = match[1]!.split('-');
      const start = value(from!, field), end = to === undefined ? (match[2] ? field.max : start) : value(to, field);
      if (start === undefined || end === undefined || end < start) return undefined;
      low = start; high = end;
    }
    for (let item = low; item <= high; item += step) values.add(item);
  }
  return values;
}

/** A five-field cron expression; `undefined` when it is not one this computer runs. */
export function parseCron(expression: string): CalendarSets | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const sets = parts.map((part, index) => parseField(part, FIELDS[index]!));
  if (sets.some(set => !set || set.size === 0)) return undefined;
  const [minutes, hours, days, months, weekdays] = sets as Set<number>[];
  if (weekdays!.delete(7)) weekdays!.add(0);
  return { minutes: [...minutes!].sort((a, b) => a - b), hours: [...hours!].sort((a, b) => a - b),
    days: days!, months: months!, weekdays: weekdays!, anyDay: parts[2]!.startsWith('*'), anyWeekday: parts[4]!.startsWith('*') };
}

function dayAllowed(sets: CalendarSets, day: Date): boolean {
  if (!sets.months.has(day.getMonth() + 1)) return false;
  const date = sets.days.has(day.getDate()), weekday = sets.weekdays.has(day.getDay());
  return sets.anyDay || sets.anyWeekday ? date && weekday : date || weekday;
}

/**
 * The nearest allowed minute strictly after `from` (`direction` 1) or at or before it (-1). Each
 * candidate is the local wall-clock time on its day, so a daylight-saving change keeps the time of day;
 * a time the change skips runs at the time the clock shows instead.
 */
export function scanCalendar(sets: CalendarSets, from: number, direction: 1 | -1): number | undefined {
  const origin = new Date(from);
  if (!Number.isFinite(origin.getTime())) return undefined;
  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const day = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate() + direction * offset);
    if (!dayAllowed(sets, day)) continue;
    let best: number | undefined;
    for (const hour of sets.hours) {
      for (const minute of sets.minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
        const allowed = direction === 1 ? at > from : at <= from;
        if (allowed && (best === undefined || (direction === 1 ? at < best : at > best))) best = at;
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}
