import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleUserMessage } from '../user-message';

test('a missing chat and a disabled provider reject delivery instead of acknowledging success', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-outcome-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  const client = { room: 'fixture-room', isConnected: true, send: async () => {},
    sendSession: async () => {}, setSessionKey: () => {} };
  const base = { type: 'user.message' as const, text: 'Synthetic task', createdAt: Date.now() };
  assert.equal(await handleUserMessage(client as never, { ...base, sessionId: 'missing-chat' }), 'rejected');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ providerSettings: { grok: false } }));
  assert.equal(await handleUserMessage(client as never, { ...base, agent: 'grok' }), 'rejected');
});
