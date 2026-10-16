import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateKeyPair } from '../../../../../packages/core/crypto';
import { publishSessionEvents } from '../../monitor/handlers/catalog';
import { restoreNativeTranscriptSource } from '../../sessions';
import type { SessionInfo, SessionsStatus } from '../../../../../packages/protocol/schema';

test('concurrent Claude reads share one reply per requesting controller and retry after failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-chat-burst-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  const priorRoot = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    if (priorRoot === undefined) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = priorRoot;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(root, { recursive: true });
  const file = join(root, 'chat.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'synthetic-entry', sessionId: 'chat',
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'Synthetic chat' } }) + '\n');
  const session: SessionInfo = { sessionId: 'chat', agent: 'claude', state: 'working',
    startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 };
  assert.equal(restoreNativeTranscriptSource(session, file), true);
  const status: SessionsStatus = { type: 'sessions.status', machine: 'Fixture', sessions: [session], generatedAt: Date.now() };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const grants: string[] = [], replies: string[] = [];
  let fail = true;
  const client = { setSessionKey: () => {},
    send: async (_: unknown, _to: unknown, options: { peerPublicKey: string }) => {
      grants.push(options.peerPublicKey); await gate;
      if (fail) throw new Error('Synthetic disconnected relay');
    },
    sendSession: async (payload: { entries: { text: string }[] }, _session: unknown, _to: unknown,
      options: { peerPublicKey: string }) => {
      assert.equal(payload.entries[0]?.text, 'Synthetic chat');
      replies.push(options.peerPublicKey);
    } };
  const first = generateKeyPair().publicKey, second = generateKeyPair().publicKey;
  const requests = Array.from({ length: 12 }, () =>
    publishSessionEvents(client as never, 'chat', status, undefined, { history: true, peerPublicKey: first }));
  requests.push(publishSessionEvents(client as never, 'chat', status, undefined, { history: true, peerPublicKey: second }));
  release();
  const results = await Promise.allSettled(requests);
  assert.equal(results.every(result => result.status === 'rejected'), true);
  assert.deepEqual(grants.sort(), [first, second].sort(), 'One controller cannot consume another controller\'s reply.');
  fail = false;
  await publishSessionEvents(client as never, 'chat', status, undefined, { history: true, peerPublicKey: first });
  assert.deepEqual(replies, [first]);
  assert.equal(grants.length, 3, 'A failed reply must not suppress a later retry.');
});
