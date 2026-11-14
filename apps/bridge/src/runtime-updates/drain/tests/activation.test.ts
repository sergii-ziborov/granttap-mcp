import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { checkForRuntimeUpdate, runtimeUpdateLoop } from '../../index';
import { selectedRuntime } from '../../selection.mjs';
import { saveAutomaticUpdateSetting } from '../../preferences/storage.mjs';
import { HOLD_LIMIT_MS, HOLD_POLL_MS, UpdateDrain } from '../index';

/** A monitor with one provider run going, a staged-able release, and phone messages that start runs. */
function fixture(verify: () => Promise<void> = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-update-drain-'));
  const bundled = join(directory, 'bundled'), state = join(directory, 'updates');
  mkdirSync(bundled);
  writeFileSync(join(bundled, 'package.json'), JSON.stringify({ name: 'granttap-mcp', version: '0.8.101' }));
  const candidate = join(state, 'versions', '0.8.102', 'node_modules', 'granttap-mcp');
  const metadata = { name: 'granttap-mcp', version: '0.8.102', dist: { integrity: 'sha512-' + Buffer.alloc(64, 3).toString('base64'),
    tarball: 'https://registry.npmjs.org/granttap-mcp/-/granttap-mcp-0.8.102.tgz' } };
  let now = 20_000_000, next = () => {};
  const runs = new Map<string, number>([['long', now]]);
  const count = { fetches: 0, verifications: 0, activations: 0, reports: 0 };
  const lines: string[] = [], delays: number[] = [], started: string[] = [], waiting: string[] = [];
  const drain = new UpdateDrain({ now: () => now, log: line => { lines.push(line); },
    oldestRun: () => runs.size ? Math.min(...runs.values()) : undefined });
  const stop = runtimeUpdateLoop({ root: bundled, directory: state, idle: () => runs.size === 0, drain, now: () => now,
    latest: async () => { count.fetches++; return metadata; }, report: () => { count.reports++; },
    schedule: ((callback: () => void, delay: number) => {
      next = callback; delays.push(delay); return setTimeout(() => {}, 100_000);
    }) as typeof setTimeout,
    check: options => checkForRuntimeUpdate({ ...options, now: () => now,
      install: async () => {
        mkdirSync(join(candidate, 'bin'), { recursive: true });
        writeFileSync(join(candidate, 'package.json'), JSON.stringify({ name: 'granttap-mcp', version: '0.8.102' }));
        writeFileSync(join(candidate, 'bin/granttap-mcp.mjs'), '');
      },
      verify: async () => { count.verifications++; await verify(); } }),
    activate: () => { count.activations++; } });
  return { bundled, state, candidate, drain, count, lines, delays, started, waiting, stop,
    selected: () => selectedRuntime(bundled, state),
    /** The durable queue: a message starts its run only while the monitor is not holding. */
    arrive: (id: string) => { if (drain.holding()) waiting.push(id); else { started.push(id); runs.set(id, now); } },
    finish: (id: string) => { runs.delete(id); },
    tick: async (after: number) => { now += after; next(); await setImmediate(); } };
}

test('a staged update activates as soon as the running work ends, although phone messages keep arriving', async t => {
  const f = fixture(); t.after(f.stop);
  await f.tick(60_000);
  assert.equal(f.drain.holding(), true, 'the staged release is valid, so new work waits for it');
  assert.equal(f.count.verifications, 1);
  assert.equal(f.delays.at(-1), HOLD_POLL_MS);
  f.arrive('first');
  await f.tick(HOLD_POLL_MS);
  f.arrive('second');
  assert.equal(f.selected(), f.bundled, 'the run that was going is not cut off');
  assert.equal(f.count.fetches, 1, 'a holding monitor does not ask the registry every five seconds');
  f.finish('long');
  await f.tick(HOLD_POLL_MS);
  assert.equal(f.selected(), f.candidate);
  assert.equal(f.count.activations, 1);
  assert.equal(f.count.verifications, 1, 'the release is not started a second time at the idle moment');
  assert.equal(f.count.fetches, 1, 'the idle moment is used at once, without asking the registry first');
  f.arrive('third');
  assert.deepEqual(f.started, [], 'nothing starts in a monitor that is about to be replaced');
  assert.deepEqual(f.waiting, ['first', 'second', 'third'], 'the new runtime delivers what arrived meanwhile');
  assert.equal(f.lines.length, 2);
  assert.match(f.lines[0]!, /0\.8\.102 is ready/);
  assert.match(f.lines[1]!, /0\.8\.102 takes over.*waited 10 s/);
});

test('a run that lasts hours gives the hold up after ten minutes, and the update activates once the monitor is idle', async t => {
  const f = fixture(); t.after(f.stop);
  await f.tick(60_000);
  f.arrive('first');
  await f.tick(HOLD_LIMIT_MS);
  assert.equal(f.drain.holding(), false);
  assert.equal(f.delays.at(-1), 60_000);
  f.arrive('second');
  assert.deepEqual(f.started, ['second'], 'phone messages run again');
  assert.equal(f.selected(), f.bundled);
  f.finish('second');
  for (let minute = 0; minute < 45; minute++) await f.tick(60_000);
  assert.equal(f.drain.holding(), false, 'no further hold while the run that outlasted the first is still going');
  assert.equal(f.count.verifications, 1, 'a busy monitor does not start the staged runtime every minute');
  f.finish('long');
  await f.tick(60_000);
  assert.equal(f.selected(), f.candidate);
  assert.equal(f.count.activations, 1);
  assert.deepEqual(f.lines.map(line => line.split(' ').slice(2, 4).join(' ')), ['is ready.', 'still waits:', 'takes over:']);
});

test('a staged release that does not start never holds phone messages', async t => {
  const f = fixture(async () => { throw Error('smoke failed'); }); t.after(f.stop);
  await f.tick(60_000);
  await f.tick(60_000);
  assert.equal(f.drain.holding(), false);
  assert.equal(f.count.verifications, 1);
  assert.equal(f.count.reports, 1);
  assert.equal(f.selected(), f.bundled);
  assert.deepEqual(f.lines, []);
});

test('a selection that fails at the idle moment ends the hold instead of failing every five seconds', async t => {
  const f = fixture(); t.after(f.stop);
  await f.tick(60_000);
  assert.equal(f.drain.holding(), true);
  // The private state file cannot be written, as on a full disk.
  mkdirSync(join(f.state, 'active.json'));
  f.finish('long');
  await f.tick(HOLD_POLL_MS);
  assert.equal(f.count.reports, 1);
  assert.equal(f.drain.holding(), false, 'phone messages run again');
  assert.equal(f.count.activations, 0);
  assert.equal(f.delays.at(-1), 60_000);
});

test('turning automatic updates off during a hold lets the waiting messages run', async t => {
  const f = fixture(); t.after(f.stop);
  await f.tick(60_000);
  assert.equal(f.drain.holding(), true);
  saveAutomaticUpdateSetting(f.state, false);
  await f.tick(HOLD_POLL_MS);
  assert.equal(f.drain.holding(), false);
  f.finish('long');
  await f.tick(60_000);
  assert.equal(f.selected(), f.bundled);
  assert.equal(f.count.activations, 0);
});
