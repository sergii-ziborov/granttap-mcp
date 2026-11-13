import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleMonitorMessage } from '../inbound';

test('the monitor leaves a sign-in result to the session that asked, as it does a question\'s answer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-monitor-sign-in-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  const sent: unknown[] = [];
  const client = { room: 'fixture-room', isConnected: true, send: async (payload: unknown) => { sent.push(payload); },
    sendSession: async (payload: unknown) => { sent.push(payload); }, setSessionKey: () => {} };
  const input = { leadership: { acquire: () => true }, subscriptions: new Set<string>(), publish: async () => {},
    peerPublicKey: 'phone-key' };
  // Returning false leaves the relay's copy for the session's own link, which holds the pending request.
  const accepted = await handleMonitorMessage(client as never, {
    type: 'signin.result', id: 'a1b2c3d4e5f6a7b8', outcome: 'completed',
    callback: { path: '/oauth/callback', query: 'code=opaque' }, createdAt: Date.now(),
  }, input);
  assert.equal(accepted, false);
  assert.deepEqual(sent, [], 'and it answers nothing and replays nothing');
});
