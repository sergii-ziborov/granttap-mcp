import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { checkForRuntimeUpdate, runtimeUpdateLoop } from '../index';
import { saveState, selectedRuntime, versionRoot } from '../selection.mjs';
// @ts-expect-error The supervisor is a launcher-only JavaScript boundary.
import { superviseRuntime } from '../supervision.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-update-preference-'));
  const bundled = join(directory, 'bundled');
  mkdirSync(bundled);
  writeFileSync(join(bundled, 'package.json'), JSON.stringify({ name: 'granttap-mcp', version: '0.8.101' }));
  const candidate = versionRoot(directory, '0.8.102');
  const toggle = (enabled: boolean) => writeFileSync(join(directory, 'preferences.json'), JSON.stringify({ automaticUpdatesEnabled: enabled }));
  const install = async () => {
    mkdirSync(join(candidate, 'bin'), { recursive: true });
    writeFileSync(join(candidate, 'bin/granttap-mcp.mjs'), '');
    writeFileSync(join(candidate, 'package.json'), JSON.stringify({ name: 'granttap-mcp', version: '0.8.102' }));
  };
  const latest = async () => ({ name: 'granttap-mcp', version: '0.8.102', dist: {
    integrity: 'sha512-' + Buffer.alloc(64, 3).toString('base64'),
    tarball: 'https://registry.npmjs.org/granttap-mcp/-/granttap-mcp-0.8.102.tgz',
  } });
  return { directory, bundled, candidate, toggle, install, latest };
}

test('a saved off preference prevents registry checks and downloads', async () => {
  const f = fixture(); f.toggle(false); let checks = 0, installs = 0;
  await checkForRuntimeUpdate({ root: f.bundled, stateDirectory: f.directory, idle: () => true,
    latest: async () => { checks++; return f.latest(); }, install: async () => { installs++; await f.install(); }, verify: async () => {} });
  assert.equal(checks, 0); assert.equal(installs, 0);
  assert.equal(selectedRuntime(f.bundled, f.directory), f.bundled);
});

test('turning updates off during verification prevents activation', async () => {
  const f = fixture(); let activated = false;
  await checkForRuntimeUpdate({ root: f.bundled, stateDirectory: f.directory, idle: () => true,
    latest: f.latest, install: f.install, verify: async () => f.toggle(false), activate: () => { activated = true; } });
  assert.equal(activated, false);
  assert.equal(selectedRuntime(f.bundled, f.directory), f.bundled);
});

test('off during registry lookup prevents installing and off during staging prevents verification', async () => {
  for (const phase of ['registry', 'staging']) {
    const f = fixture(); let installs = 0, verified = 0;
    await checkForRuntimeUpdate({ root: f.bundled, stateDirectory: f.directory, idle: () => true,
      latest: async () => { if (phase === 'registry') f.toggle(false); return f.latest(); },
      install: async () => { installs++; await f.install(); f.toggle(false); },
      verify: async () => { verified++; } });
    assert.equal(installs, phase === 'registry' ? 0 : 1); assert.equal(verified, 0);
    assert.equal(selectedRuntime(f.bundled, f.directory), f.bundled);
  }
});

test('the running loop observes off and on without a service restart', async () => {
  const f = fixture(); f.toggle(false); let tick = () => {}, checks = 0;
  const stop = runtimeUpdateLoop({ root: f.bundled, directory: f.directory, idle: () => true,
    check: async () => { checks++; return undefined; },
    schedule: ((cb: () => void) => { tick = cb; return setTimeout(() => {}, 10000); }) as typeof setTimeout });
  try {
    tick(); await setImmediate(); assert.equal(checks, 0);
    f.toggle(true); tick(); await setImmediate(); assert.equal(checks, 1);
    f.toggle(false); tick(); await setImmediate(); assert.equal(checks, 1);
  } finally { stop(); }
});

test('off prevents an already requested owned-service handoff and preserves the selected runtime', async () => {
  const f = fixture(); await f.install(); let tick = () => {}, kills = 0, requests = 0;
  const child = Object.assign(new EventEmitter(), { connected: true, send: () => { requests++; }, kill: () => { kills++; } });
  const guard = superviseRuntime(child, { ...f, root: f.bundled,
    schedule: (cb: () => void) => { tick = cb; return setInterval(() => {}, 10000); } });
  try {
    saveState(f.directory, { root: f.candidate, version: '0.8.102' }); tick(); assert.equal(requests, 1);
    f.toggle(false); child.emit('message', { type: 'granttap.runtime-update-ready' });
    tick(); assert.equal(kills, 0); assert.equal(requests, 1);
    assert.equal(selectedRuntime(f.bundled, f.directory), f.candidate);
    f.toggle(true); tick(); child.emit('message', { type: 'granttap.runtime-update-ready' }); assert.equal(kills, 1);
  } finally { guard.stop(); }
});
