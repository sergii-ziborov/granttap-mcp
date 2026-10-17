import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rememberPublishedCatalog } from '../../../session-catalog';
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

test('a message to a chat the published catalog knows does not wait for a full provider scan', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-outcome-catalog-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ providerSettings: { grok: false } }));
  const said: string[] = [];
  const client = { room: 'fixture-room', isConnected: true, send: async () => {}, setSessionKey: () => {},
    sendSession: async (payload: { text?: string }) => { if (payload.text) said.push(payload.text); } };
  rememberPublishedCatalog(client as never, { type: 'sessions.status', machine: 'Fixture Mac', generatedAt: Date.now(),
    sessions: [{ sessionId: 'catalog-only-chat', agent: 'grok', state: 'idle', startedAt: 1, lastActivityAt: 2,
      tokensSession: 0, tokensLastTurn: 0, cwd: root }] });
  const outcome = await handleUserMessage(client as never,
    { type: 'user.message', text: 'Synthetic follow-up', createdAt: Date.now(), sessionId: 'catalog-only-chat' });
  assert.equal(outcome, 'rejected');
  assert.deepEqual(said, ['This agent is disabled in GrantTap Settings.'],
    'the catalog row was the target; a rescan would not have found this synthetic chat');
});
