import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HANDOFF_LIMIT_MS, HOLD_LIMIT_MS, HOLD_PAUSE_MS, HOLD_RETRY_MS, UpdateDrain, VERIFY_RETRY_MS } from '../index';
import { holdSentence, readHoldState, writeHoldState, type UpdateBlocker, type UpdateHold } from '../state';

function fixture() {
  let now = Date.UTC(2026, 10, 17, 10, 0), oldest: number | undefined, blockers: UpdateBlocker[] = [], surviving = 0;
  const reports: Array<UpdateHold | undefined> = [], events: string[] = [];
  const drain = new UpdateDrain({ now: () => now, oldestRun: () => oldest, blockers: () => blockers,
    survivingRuns: () => surviving, report: hold => { reports.push(hold); },
    onHandoff: () => { events.push('handoff'); }, onHandoffLapsed: () => { events.push('lapsed'); } });
  return { drain, reports, events, at: () => now, pass: (ms: number) => { now += ms; },
    set: (next: { oldest?: number; blockers?: UpdateBlocker[]; surviving?: number }) => {
      oldest = next.oldest; blockers = next.blockers ?? []; surviving = next.surviving ?? 0;
    } };
}

test('a hold says what it waits for, since when, and until when', () => {
  const f = fixture(), since = f.at();
  f.set({ oldest: since - 60_000, blockers: [{ kind: 'run', sessionId: 'cursor-chat-1', since: since - 60_000 },
    { kind: 'approval', count: 2 }], surviving: 3 });
  assert.equal(f.drain.state(), undefined, 'nothing waits before an update is ready');
  f.drain.request('0.8.188');
  assert.deepEqual(f.reports.at(-1), { version: '0.8.188', phase: 'holding', since, holdUntil: since + HOLD_LIMIT_MS, attempts: 0,
    blockers: [{ kind: 'run', sessionId: 'cursor-chat-1', since: since - 60_000 }, { kind: 'approval', count: 2 }],
    survivingRuns: 3, updatedAt: since });
  assert.equal(holdSentence(f.reports.at(-1)!), 'New phone messages wait for it since 10:00 UTC, until 10:10 UTC at the latest; '
    + 'it waits for a run in chat cursor-c (since 09:59 UTC), 2 approvals waiting on the phone. 3 running chats keep going and '
    + 'are taken over by the new version.');
  const reported = f.reports.length;
  f.pass(1_000);
  f.drain.holding();
  assert.equal(f.reports.length, reported, 'a hold that goes on is reported once a poll, not on every look');
  f.pass(5_000);
  f.drain.holding();
  assert.equal(f.reports.length, reported + 1);
});

test('a hold that gave up says when the next one comes, and whether it waits for the runs to end', () => {
  const f = fixture();
  f.set({ oldest: f.at() - 1, blockers: [{ kind: 'run', newTask: 'cursor', since: f.at() - 1 }] });
  f.drain.request('0.8.188');
  f.pass(HOLD_LIMIT_MS);
  f.drain.holding();
  const first = f.reports.at(-1)!;
  assert.equal(first.phase, 'waiting');
  assert.equal(first.nextAttemptAt, f.at() + HOLD_PAUSE_MS);
  assert.equal(first.afterRunsEnd, true);
  assert.equal(first.attempts, 1);
  assert.match(holdSentence(first), /^The last wait gave up; the next one starts at 10:15 UTC at the earliest, once the runs it waited for have ended\. Still going: a new cursor task being created\.$/);
  f.set({});
  f.pass(HOLD_PAUSE_MS);
  f.drain.request('0.8.188');
  f.set({ blockers: [{ kind: 'sign-in' }] });
  f.pass(HOLD_LIMIT_MS);
  f.drain.holding();
  const second = f.reports.at(-1)!;
  assert.deepEqual([second.phase, second.attempts, second.nextAttemptAt, second.afterRunsEnd], ['waiting', 2, f.at() + HOLD_RETRY_MS, undefined]);
  assert.match(holdSentence(second), /gave up \(2 in a row\); the next one starts at \d\d:\d\d UTC\. Still going: a provider sign-in\.$/);
  assert.equal(f.drain.request('0.8.188'), false);
  assert.equal(f.reports.at(-1)?.phase, 'waiting', 'a request that cannot start a hold yet still says when it will');
});

test('a handover is reported, freezes the runs, and gives them back if the monitor is not replaced', () => {
  const f = fixture();
  f.set({ surviving: 1 });
  f.drain.request('0.8.188');
  f.drain.handoff('0.8.188');
  assert.deepEqual(f.events, ['handoff']);
  assert.equal(f.reports.at(-1)?.phase, 'handing-over');
  assert.equal(holdSentence(f.reports.at(-1)!), 'It is taking over now. 1 running chat keeps going and is taken over by the new version.');
  f.pass(HANDOFF_LIMIT_MS);
  assert.equal(f.drain.holding(), false);
  assert.deepEqual(f.events, ['handoff', 'lapsed']);
  assert.equal(f.reports.at(-1)?.phase, 'waiting');
});

test('a release that does not start, and updates turned off, are reported too', async () => {
  const f = fixture();
  await assert.rejects(f.drain.verified('0.8.188', async () => { throw new Error('broken'); }));
  const broken = f.reports.at(-1)!;
  assert.deepEqual([broken.phase, broken.nextAttemptAt], ['start-check-failed', f.at() + VERIFY_RETRY_MS]);
  assert.match(holdSentence(broken), /^It did not start when checked; it is tried again at \d\d:\d\d UTC\.$/);
  f.pass(VERIFY_RETRY_MS);
  f.drain.request('0.8.188');
  f.drain.cancel();
  assert.equal(f.reports.at(-1), undefined, 'automatic updates off: nothing waits any more');
  f.drain.request('0.8.188');
  f.drain.failed();
  assert.equal(f.reports.at(-1)?.phase, 'waiting');
});

test('the hold is read from another process only while the monitor that wrote it runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-hold-state-'));
  try {
    const hold: UpdateHold = { version: '0.8.188', phase: 'holding', since: 1, holdUntil: 2, attempts: 0,
      blockers: [{ kind: 'answer' }, { kind: 'maintenance' }, { kind: 'command', count: 1 }], survivingRuns: 0, updatedAt: 3 };
    writeHoldState(directory, hold);
    assert.deepEqual(readHoldState(directory), hold);
    assert.match(holdSentence(hold), /an answer being sent to the phone, a computer maintenance action, 1 phone request being handled\.$/);
    assert.equal(readHoldState(directory, () => false), undefined, 'a monitor that is gone holds nothing');
    writeHoldState(directory, undefined);
    assert.equal(readHoldState(directory), undefined);
    assert.deepEqual(readdirSync(directory), []);
    writeHoldState(join(directory, 'missing', '\0bad'), hold);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
