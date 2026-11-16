import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { rememberPublishedCatalog } from '../../../session-catalog';
import { visibleUserText } from '../../../sessions/support/activity-helpers';
import { queueNote } from '../../../task-dispatch/queue-note';
import { handleUserMessage } from '../user-message';

/** A Claude Code stand-in that answers with the prompt it was given. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-queue-note-'));
  const stub = join(root, 'claude-stub');
  writeFileSync(stub, ['#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ result: process.argv.at(-1), session_id: 'new-chat' }));"].join('\n'),
  { mode: 0o755 });
  const prior = { config: process.env.GRANTTAP_CONFIG_DIR, claude: process.env.GRANTTAP_CLAUDE_BIN };
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_CLAUDE_BIN = stub;
  t.after(() => {
    for (const [name, value] of [['GRANTTAP_CONFIG_DIR', prior.config], ['GRANTTAP_CLAUDE_BIN', prior.claude]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const said: string[] = [];
  const client = { room: 'queue-note-room', isConnected: true, setSessionKey: () => {},
    send: async (payload: { kind?: string; text?: string }) => { if (payload.kind === 'response' && payload.text) said.push(payload.text); },
    sendSession: async (payload: { kind?: string; text?: string }) => {
      if (payload.kind === 'response' && payload.text) said.push(payload.text);
    } };
  rememberPublishedCatalog(client as never, { type: 'sessions.status', machine: 'Fixture Mac', generatedAt: Date.now(),
    sessions: [{ sessionId: 'queued-chat', agent: 'claude', state: 'idle', startedAt: 1, lastActivityAt: 2,
      tokensSession: 0, tokensLastTurn: 0, cwd: root }] });
  return { client, said };
}

test('a message with more queued behind it tells the agent so, after the person\'s own words', async t => {
  const f = fixture(t), text = 'Rename the helper and update its callers';
  let asked = 0;
  const outcome = await handleUserMessage(f.client as never,
    { type: 'user.message', sessionId: 'queued-chat', messageId: 'queued-message-1', text, createdAt: Date.now() },
    undefined, undefined, undefined, undefined, () => { asked++; return 3; });
  assert.equal(outcome, 'accepted');
  assert.equal(asked, 1, 'the queue is read once, when the prompt is written');
  assert.deepEqual(f.said, [`${text}\n\n${queueNote(3)}`]);
  assert.equal(visibleUserText(f.said[0]), text, 'the phone shows only what the person typed');
});

test('nothing is added when no message waits, and a new task hears of the follow-ups written for it', async t => {
  const f = fixture(t), text = 'Start a changelog for this repository';
  await handleUserMessage(f.client as never,
    { type: 'user.message', sessionId: 'queued-chat', messageId: 'queued-message-2', text, createdAt: Date.now() },
    undefined, undefined, undefined, undefined, () => 0);
  await handleUserMessage(f.client as never,
    { type: 'user.message', sessionId: 'queued-chat', messageId: 'queued-message-3', text, createdAt: Date.now() });
  await handleUserMessage(f.client as never,
    { type: 'user.message', agent: 'claude', messageId: 'queued-new-task', text, createdAt: Date.now() },
    undefined, undefined, undefined, undefined, () => 1);
  assert.deepEqual(f.said, [text, text, `${text}\n\n${queueNote(1)}`]);
});
