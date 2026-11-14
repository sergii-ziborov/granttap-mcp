import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { EventEmitter } from 'node:events';
import { runtimeUpdateReadiness } from '../../readiness';
import { HOLD_LIMIT_MS, UpdateDrain } from '../index';

/** The launcher asks its monitor every ten seconds while a newer runtime is selected. */
function fixture(t: TestContext) {
  const sent: unknown[] = [], lines: string[] = [], before = process.send;
  process.send = ((message: unknown) => { sent.push(message); return true; }) as typeof process.send;
  const state = { idle: false, now: 1_000_000 };
  const drain = new UpdateDrain({ now: () => state.now, log: line => { lines.push(line); } });
  const stop = runtimeUpdateReadiness(() => state.idle, drain);
  t.after(() => { stop(); process.send = before; });
  return { sent, lines, state, drain,
    ask: (after = 10_000) => {
      state.now += after;
      (process as EventEmitter).emit('message', { type: 'granttap.runtime-update-check' });
    } };
}

test('a runtime selected while the monitor is busy drains it instead of waiting for an idle moment', t => {
  const f = fixture(t);
  assert.equal(f.sent.length, 1, 'startup health');
  (process as EventEmitter).emit('message', { type: 'unrelated' });
  assert.equal(f.drain.holding(), false, 'only the launcher\'s own question starts a hold');
  f.ask();
  assert.equal(f.sent.length, 1, 'a busy monitor is not ready');
  assert.equal(f.drain.holding(), true, 'but it stops starting new work');
  f.ask();
  assert.equal(f.lines.length, 1);
  f.state.idle = true;
  f.ask();
  assert.deepEqual(f.sent[1], { type: 'granttap.runtime-update-ready' });
  assert.equal(f.drain.holding(), true, 'nothing new starts while the launcher replaces the monitor');
  assert.match(f.lines[1]!, /newer runtime takes over.*waited 20 s/);
});

test('a monitor that stays busy lets its messages run again, and is ready later without another hold', t => {
  const f = fixture(t);
  f.ask();
  assert.equal(f.drain.holding(), true);
  f.ask(HOLD_LIMIT_MS);
  assert.equal(f.drain.holding(), false);
  assert.match(f.lines[1]!, /still waits/);
  assert.equal(f.sent.length, 1);
  f.state.idle = true;
  f.ask();
  assert.equal(f.sent.length, 2, 'an idle moment is still used at once');
});
