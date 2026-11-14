import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDOFF_LIMIT_MS, HOLD_LIMIT_MS, HOLD_PAUSE_MS, HOLD_RETRY_MS, UpdateDrain, VERIFY_RETRY_MS } from '../index';

function fixture() {
  let now = 1_000_000_000, oldest: number | undefined;
  const lines: string[] = [];
  const drain = new UpdateDrain({ now: () => now, log: line => { lines.push(line); }, oldestRun: () => oldest });
  return { drain, lines, at: () => now, pass: (ms: number) => { now += ms; },
    run: (startedAt?: number) => { oldest = startedAt; } };
}

test('a waiting update holds new work for at most ten minutes and says so in the monitor log', () => {
  const f = fixture();
  assert.equal(f.drain.holding(), false);
  assert.equal(f.drain.request('0.8.172'), true);
  assert.equal(f.drain.holding(), true);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0]!, /0\.8\.172 is ready/);
  f.pass(HOLD_LIMIT_MS - 1);
  assert.equal(f.drain.request('0.8.172'), true);
  assert.equal(f.drain.holding(), true);
  assert.equal(f.lines.length, 1, 'one line when the hold starts, not one per check');
  f.pass(1);
  assert.equal(f.drain.holding(), false, 'other chats are not starved behind a long run');
  assert.equal(f.lines.length, 2);
  assert.match(f.lines[1]!, /0\.8\.172 still waits.*run again/);
  assert.ok(HOLD_LIMIT_MS <= 10 * 60_000);
});

test('a hold that an hours-long run outlasted is not repeated until that run has ended', () => {
  const f = fixture();
  f.run(f.at() - 60 * 60_000);
  f.drain.request('0.8.172');
  f.pass(HOLD_LIMIT_MS);
  assert.equal(f.drain.holding(), false);
  assert.match(f.lines[1]!, /when the runs still going have ended/);
  f.pass(4 * HOLD_RETRY_MS);
  assert.equal(f.drain.request('0.8.172'), false, 'a hold cannot succeed while the same run is still going');
  assert.equal(f.drain.holding(), false);
  f.run(f.at() - 60_000);
  assert.equal(f.drain.request('0.8.172'), true, 'that run ended; what runs now began after the hold gave up');
  assert.equal(f.lines.length, 3);
});

test('messages that waited through a hold get a pause to start before the next one', () => {
  const f = fixture();
  f.run(f.at() - 60_000);
  f.drain.request('0.8.172');
  f.pass(HOLD_LIMIT_MS);
  assert.equal(f.drain.holding(), false);
  f.run(undefined);
  f.pass(HOLD_PAUSE_MS - 1);
  assert.equal(f.drain.request('0.8.172'), false);
  f.pass(1);
  assert.equal(f.drain.request('0.8.172'), true);
  assert.ok(HOLD_PAUSE_MS >= 60_000);
});

test('a hold that gave up without a provider run to blame is tried again half an hour later', () => {
  const f = fixture();
  f.drain.request('0.8.172');
  f.pass(HOLD_LIMIT_MS);
  assert.equal(f.drain.holding(), false);
  assert.match(f.lines[1]!, /in 30 min/);
  f.pass(HOLD_RETRY_MS - 1);
  assert.equal(f.drain.request('0.8.172'), false);
  f.pass(1);
  assert.equal(f.drain.request('0.8.172'), true);
});

test('once the update is selected, new work stays held until the launcher replaces the monitor', () => {
  const f = fixture();
  f.drain.request('0.8.172');
  f.pass(42_000);
  f.drain.handoff('0.8.172');
  f.drain.handoff('0.8.172');
  assert.equal(f.lines.length, 2, 'one line when the update activates');
  assert.match(f.lines[1]!, /0\.8\.172 takes over.*restarts.*42 s/);
  f.pass(HOLD_LIMIT_MS - 42_000);
  assert.equal(f.drain.holding(), false, 'a launcher that never restarts the monitor cannot hold messages for good');
  assert.match(f.lines[2]!, /was not restarted/);
  assert.ok(HANDOFF_LIMIT_MS <= 2 * 60_000);
});

test('an idle monitor that activates at once still holds new work while it is being replaced', () => {
  const f = fixture();
  f.drain.handoff('0.8.172');
  assert.equal(f.drain.holding(), true);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0]!, /0\.8\.172 takes over/);
  f.pass(HANDOFF_LIMIT_MS - 1);
  assert.equal(f.drain.holding(), true);
  f.pass(1);
  assert.equal(f.drain.holding(), false);
});

test('a runtime selected from the phone is named without its version', () => {
  const f = fixture();
  f.drain.request();
  assert.match(f.lines[0]!, /^The newer runtime is ready/);
});

test('turning automatic updates off lets the held messages run at once', () => {
  const f = fixture();
  f.drain.cancel();
  assert.equal(f.lines.length, 0);
  f.drain.request('0.8.172');
  f.drain.cancel();
  assert.equal(f.drain.holding(), false);
  assert.match(f.lines[1]!, /automatic updates are off/);
  assert.equal(f.drain.request('0.8.172'), true, 'turning them back on does not wait out a retry pause');
});

test('an update that cannot be selected gives its hold up at once instead of keeping messages waiting', () => {
  const f = fixture();
  f.drain.failed();
  assert.equal(f.lines.length, 0);
  f.drain.request('0.8.172');
  f.drain.failed();
  assert.equal(f.drain.holding(), false);
  assert.match(f.lines[1]!, /0\.8\.172 could not be selected.*run again/);
  f.pass(HOLD_RETRY_MS - 1);
  assert.equal(f.drain.request('0.8.172'), false);
  f.pass(1);
  assert.equal(f.drain.request('0.8.172'), true);
});

test('a busy monitor starts a staged release once, and a broken one not again for half an hour', async () => {
  const f = fixture();
  let runs = 0, broken = true;
  const verify = async () => { runs++; if (broken) throw Error('smoke failed'); };
  await assert.rejects(f.drain.verified('0.8.172', verify), /smoke failed/);
  assert.equal(await f.drain.verified('0.8.172', verify), false);
  assert.equal(runs, 1, 'a broken release does not start two Node processes on every check');
  f.pass(VERIFY_RETRY_MS);
  broken = false;
  assert.equal(await f.drain.verified('0.8.172', verify), true);
  assert.equal(await f.drain.verified('0.8.172', verify), true);
  assert.equal(runs, 2, 'a release that passed is not started again on every check');
  assert.equal(await f.drain.verified('0.8.173', verify), true);
  assert.equal(runs, 3, 'each release is verified itself');
});
