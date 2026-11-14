import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveRuntimeConfig } from '../../../config';
import { startSessionMonitor } from '../..';
import { acceptWhenStarted } from '../../message-delivery/acceptance';

test('a monitor is not replaced while a queued delivery is in its handler or a late answer is on its way', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-update-readiness-'));
  const names = ['GRANTTAP_CONFIG_DIR', 'GRANTTAP_CODEX_DIR', 'GRANTTAP_CODEX_SESSIONS_DIR',
    'GRANTTAP_CLAUDE_PROJECTS_DIR', 'GRANTTAP_CURSOR_TRANSCRIPTS_DIR', 'GRANTTAP_GROK_SESSIONS_DIR'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = root;
  saveRuntimeConfig({ meshEnabled: false,
    providerSettings: { claude: false, codex: false, cursor: false, grok: false } });
  const client = { room: 'isolated', isConnected: true, onMessage: () => () => {}, setSessionKey: () => {},
    sendSession: async () => {}, send: async () => {} };
  const monitor = startSessionMonitor(client as never);
  t.after(async () => {
    monitor.close(); await new Promise<void>(resolve => setImmediate(resolve));
    for (const name of names) {
      if (prior[name] == null) delete process.env[name]; else process.env[name] = prior[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(monitor.canUpdate(), true);

  let returned = () => {};
  const delivery = monitor.track(() => new Promise<void>(resolve => { returned = resolve; }));
  assert.equal(monitor.canUpdate(), false, 'the message is claimed, but its provider run has not started yet');
  returned(); await delivery;
  assert.equal(monitor.canUpdate(), true);

  let ended = () => {}, sent = () => {};
  const run = new Promise<void>(resolve => { ended = resolve; });
  const sending = new Promise<void>(resolve => { sent = resolve; });
  assert.equal(await acceptWhenStarted(run, () => sending, 5), 'started');
  assert.equal(monitor.canUpdate(), false);
  ended(); await turn();
  assert.equal(monitor.canUpdate(), false, 'the run ended; its answer has not reached the phone yet');
  sent(); await turn();
  assert.equal(monitor.canUpdate(), true);
});
