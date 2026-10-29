import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { SessionInfo } from '../../../../../packages/protocol/schema';
import type { RelayClient } from '../../../../../packages/core/relay-client';
import { codexLogPathBySession } from '../../sessions/scan/codex/shared';
import { publishCodexQuestions } from '..';
import { questionId } from '../observations';
import { saveQuestion } from '../records';

test('one publication reads the private question collection once for all chats', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'granttap-question-batch-'));
  const before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const sessions: SessionInfo[] = [];
  for (let index = 0; index < 20; index++) {
    const sessionId = 'batch-session-' + index, path = join(root, sessionId + '.jsonl');
    fs.writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n');
    codexLogPathBySession.set(sessionId, path);
    sessions.push({ sessionId, agent: 'codex', state: 'idle', startedAt: Date.now(),
      lastActivityAt: Date.now(), tokensSession: 0, tokensLastTurn: 0 });
    saveQuestion({ requestId: questionId(sessionId, 'call', 0), sessionId, callId: 'call', index: 0,
      question: 'Fixture question', options: [], createdAt: Date.now(), room: 'fixture-room', announced: true });
  }
  t.after(() => {
    for (const session of sessions) codexLogPathBySession.delete(session.sessionId);
    if (before === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const original = fs.readFileSync, records = join(root, 'codex-question-records');
  let reads = 0, sends = 0;
  t.mock.method(fs, 'readFileSync', (path: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (typeof path === 'string' && dirname(path) === records) reads++;
    return Reflect.apply(original, fs, [path, ...args]);
  });
  syncBuiltinESMExports();
  try {
    const client = { room: 'fixture-room', send: async () => { sends++; } } as unknown as RelayClient;
    await publishCodexQuestions(client, sessions);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(sends, 0, 'Already announced questions do not produce duplicate messages');
  assert.ok(reads <= sessions.length * 2,
    `Observed ${reads} private record reads for ${sessions.length} chats; publication must stay linear`);
});
