import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRuntimeConfig } from '../../../../apps/bridge/src/config';
import { startSessionMonitor } from '../../../../apps/bridge/src/monitor';
import { rememberPublishedCatalog } from '../../../../apps/bridge/src/session-catalog';
import type { Payload, SessionsStatus } from '../../../protocol/schema';

test('startup publishes the saved catalog before fresh provider discovery', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-startup-catalog-'));
  const names = ['GRANTTAP_CONFIG_DIR', 'GRANTTAP_CODEX_DIR', 'GRANTTAP_CODEX_SESSIONS_DIR',
    'GRANTTAP_CLAUDE_PROJECTS_DIR', 'GRANTTAP_GROK_SESSIONS_DIR',
    'GRANTTAP_CURSOR_TRANSCRIPTS_DIR', 'GRANTTAP_ENGINE_ENABLED'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = root;
  process.env.GRANTTAP_ENGINE_ENABLED = '0';
  saveRuntimeConfig({ meshEnabled: false,
    providerSettings: { codex: false, claude: false, cursor: false, grok: false } });
  const catalogs: SessionsStatus[] = [];
  const client = { room: 'startup-fixture', isConnected: true,
    onMessage: () => () => {}, setSessionKey: () => {},
    send: async (payload: Payload) => {
      if (payload.type === 'sessions.status') catalogs.push(payload);
    }, sendSession: async () => {} };
  const saved: SessionsStatus = { type: 'sessions.status', machine: 'Saved computer',
    generatedAt: 123, sessions: [], history: [] };
  rememberPublishedCatalog(client as never, saved);
  const monitor = startSessionMonitor(client as never);
  t.after(() => {
    monitor.close();
    for (const name of names) {
      if (prior[name] == null) delete process.env[name]; else process.env[name] = prior[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  await monitor.publish();
  assert.deepEqual(catalogs[0], saved, 'saved timestamps are preserved before the fresh scan');
  assert.ok(catalogs.some(status => status.generatedAt! > saved.generatedAt!), 'fresh discovery follows');
});
