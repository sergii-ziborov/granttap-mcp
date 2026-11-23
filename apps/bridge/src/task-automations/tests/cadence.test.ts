import assert from 'node:assert/strict';
import test from 'node:test';
import { lastOccurrence, nextOccurrence, occurrencesBetween, scheduleProblem } from '../cadence';
import { parseCron } from '../cadence/cron';
import { day, hour, minute } from './fixture';

// Berlin moves its clocks on 2026-03-29 (02:00 → 03:00) and 2026-10-25 (03:00 → 02:00).
process.env.TZ = 'Europe/Berlin';
const local = (month: number, date: number, h: number, m = 0) => new Date(2026, month - 1, date, h, m).getTime();

test('every N hours counts elapsed hours from when it was saved, through a daylight-saving change', () => {
  const anchor = local(3, 29, 0, 30), every = { kind: 'hours' as const, every: 2 };
  assert.equal(nextOccurrence(every, anchor, anchor), anchor + 2 * hour);
  assert.equal(nextOccurrence(every, anchor + 2 * hour, anchor), anchor + 4 * hour);
  assert.equal(nextOccurrence(every, anchor + 2 * hour - 1, anchor), anchor + 2 * hour);
  assert.equal(new Date(anchor + 2 * hour).getHours(), 3, 'two elapsed hours after 00:30 on the change night is 03:30');
  assert.equal(lastOccurrence(every, anchor + hour, anchor), undefined, 'nothing ran before the first two hours');
  assert.equal(lastOccurrence(every, anchor + 5 * hour, anchor), anchor + 4 * hour);
  assert.equal(occurrencesBetween(every, anchor + 2 * hour, anchor + 10 * hour, anchor), 5);
  assert.equal(occurrencesBetween(every, anchor + 2 * hour, anchor + 10 * hour, anchor, 3), 3);
  assert.equal(occurrencesBetween(every, anchor + 3 * hour, anchor + 2 * hour, anchor), 0);
});

test('daily at a time runs on the chosen weekdays, every day when none are chosen, at the same wall-clock time', () => {
  const weekdays = { kind: 'daily' as const, hour: 9, minute: 15, weekdays: ['MO' as const, 'FR' as const] };
  // 2026-03-27 is a Friday.
  assert.equal(nextOccurrence(weekdays, local(3, 27, 8), 0), local(3, 27, 9, 15));
  assert.equal(nextOccurrence(weekdays, local(3, 27, 9, 15), 0), local(3, 30, 9, 15), 'Friday 09:15 itself is not after itself');
  const daily = { kind: 'daily' as const, hour: 9, minute: 0, weekdays: [] };
  const saturday = nextOccurrence(daily, local(3, 27, 10), 0)!;
  assert.equal(saturday, local(3, 28, 9));
  assert.equal(nextOccurrence(daily, saturday, 0)! - saturday, 23 * hour, 'the clock change night is an hour short');
  assert.equal(new Date(nextOccurrence(daily, saturday, 0)!).getHours(), 9);
  assert.equal(lastOccurrence(daily, local(3, 28, 8, 59), 0), local(3, 27, 9));
  assert.equal(occurrencesBetween(daily, local(3, 20, 0), local(3, 27, 23), 0), 8);
  const night = { kind: 'daily' as const, hour: 2, minute: 30, weekdays: [] };
  assert.equal(new Date(nextOccurrence(night, local(3, 29, 0), 0)!).getHours(), 3, 'a skipped 02:30 runs at the time the clock shows');
});

test('a one-time run is due once, must be ahead when chosen, and has no run after it', () => {
  const once = { kind: 'once' as const, at: local(4, 1, 12) };
  assert.equal(nextOccurrence(once, local(4, 1, 11), 0), once.at);
  assert.equal(nextOccurrence(once, once.at, 0), undefined);
  assert.equal(lastOccurrence(once, once.at - 1, 0), undefined);
  assert.equal(lastOccurrence(once, once.at + day, 0), once.at);
  assert.equal(scheduleProblem(once, once.at - minute), undefined);
  assert.equal(scheduleProblem(once, once.at), 'Choose a time in the future.');
  assert.equal(scheduleProblem({ kind: 'hours', every: 3 }, 0), undefined);
});

test('cron takes five fields of values, ranges, steps, lists and names, and refuses anything else', () => {
  const work = { kind: 'cron' as const, expression: '*/20 9-10 * * MON-FRI' };
  assert.equal(scheduleProblem(work, local(3, 27, 8)), undefined);
  assert.deepEqual([1, 2, 3, 4, 5, 6].reduce<number[]>((times, _) => {
    times.push(nextOccurrence(work, times.at(-1) ?? local(3, 27, 8), 0)!); return times;
  }, []).map(at => new Date(at).toTimeString().slice(0, 5)), ['09:00', '09:20', '09:40', '10:00', '10:20', '10:40']);
  assert.equal(nextOccurrence(work, local(3, 27, 10, 40), 0), local(3, 30, 9), 'Friday evening waits for Monday');
  assert.equal(lastOccurrence(work, local(3, 28, 12), 0), local(3, 27, 10, 40));
  // A restricted day of month and weekday match on either one, as in Vixie cron.
  const either = { kind: 'cron' as const, expression: '0 12 1 * SUN' };
  assert.equal(nextOccurrence(either, local(3, 27, 0), 0), local(3, 29, 12), 'the Sunday');
  assert.equal(nextOccurrence(either, local(3, 29, 13), 0), local(4, 1, 12), 'the first of the month');
  assert.equal(nextOccurrence({ kind: 'cron', expression: '0 0 29 2 *' }, local(3, 1, 0), 0), new Date(2028, 1, 29).getTime());
  assert.equal(nextOccurrence({ kind: 'cron', expression: '0 8 * * 7' }, local(3, 27, 0), 0), local(3, 29, 8), '7 is Sunday');
  assert.equal(nextOccurrence({ kind: 'cron', expression: '15 6 1-7/3 jan,Apr *' }, local(3, 27, 0), 0), local(4, 1, 6, 15));
  assert.equal(nextOccurrence({ kind: 'cron', expression: '5/30 * * * *' }, local(3, 27, 8), 0), local(3, 27, 8, 5));
  for (const expression of ['* * * *', '60 * * * *', '*/0 * * * *', 'a b c d e', '5-1 * * * *', '0 24 * * *',
    '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '0 0 * * MON-', '1,,2 * * * *', '* * * * * *']) {
    assert.equal(parseCron(expression), undefined, expression);
    assert.equal(scheduleProblem({ kind: 'cron', expression }, 0), 'Use five cron fields: minute, hour, day of month, month and weekday.');
  }
  assert.equal(scheduleProblem({ kind: 'cron', expression: '0 0 31 2 *' }, local(3, 1, 0)), 'This schedule never runs.');
  assert.equal(nextOccurrence({ kind: 'cron', expression: 'nope' }, 0, 0), undefined);
  assert.equal(lastOccurrence({ kind: 'cron', expression: 'nope' }, 0, 0), undefined);
});

test('the autumn change keeps daily runs at their wall-clock time and minute steps run every minute', () => {
  const daily = { kind: 'daily' as const, hour: 9, minute: 0, weekdays: [] };
  const saturday = local(10, 24, 9);
  assert.equal(nextOccurrence(daily, saturday, 0)! - saturday, 25 * hour);
  const everyMinute = { kind: 'cron' as const, expression: '* * * * *' };
  assert.equal(occurrencesBetween(everyMinute, local(10, 24, 9), local(10, 24, 10), 0), 61);
  assert.equal(lastOccurrence(everyMinute, local(10, 24, 9, 30) + 30_000, 0), local(10, 24, 9, 30));
  assert.equal(nextOccurrence(everyMinute, Number.NaN, 0), undefined);
});
