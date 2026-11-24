import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { handleUserMessage } from '../../monitor/handlers/user-message';
import { resolveTaskOriginJob, TaskOriginRegistry } from '../index';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-origin-creation-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ providerSettings: { codex: true } }));
  const said: { text: string; sessionId?: string; kind?: string }[] = [];
  const client = { room: 'room', isConnected: true, setSessionKey: () => {},
    send: async (payload: { text: string }) => { said.push(payload); },
    sendSession: async (payload: { text: string }) => { said.push(payload); } };
  const message = { type: 'user.message' as const, text: 'Synthetic task', createdAt: 1,
    messageId: 'parent', taskOriginId: 'parent', agent: 'codex' as const };
  const scope = { room: 'room', peerPublicKey: 'controller', originMessageId: 'parent' };
  return { root, message, scope, said, client, registry: new TaskOriginRegistry(join(root, 'task-origins')) };
}

test('a duplicate native creation reports the existing chat without invoking another provider', async t => {
  const f = fixture(t);
  f.registry.begin(f.scope, { ...f.message, attachments: [] });
  f.registry.complete(f.scope, { ok: true, sessionId: 'native-chat' });
  const result = await handleUserMessage(f.client as never, { ...f.message, createdAt: 2 }, undefined, 'controller');
  assert.equal(result, 'accepted');
  assert.equal(f.said.at(-1)?.sessionId, 'native-chat');
  assert.equal(f.said.at(-1)?.kind, 'status');
});

test('an unclaimed creation releases its reservation, while a workspace failure records a definite failure', async t => {
  const f = fixture(t);
  await assert.rejects(handleUserMessage(f.client as never, f.message,
    async () => { throw new Error('Synthetic cancelled claim'); }, 'controller'));
  assert.equal(f.registry.lookup(f.scope, 'codex').state, 'waiting');
  writeFileSync(join(f.root, 'workspaces'), 'This synthetic path is a file');
  assert.equal(await handleUserMessage(f.client as never, f.message, undefined, 'controller'), 'rejected');
  assert.equal(f.registry.lookup(f.scope, 'codex').state, 'failed');
  assert.ok(f.said.some(item => /Could not create/.test(item.text ?? '')));
  assert.match((f.said.at(-1) as { error?: string }).error ?? '', /^Could not create a Codex task/,
    'the rejection receipt carries the same reason');
});

test('a new task refused before it starts tells the phone, fails its follow-ups, and can be retried', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'config.json'), JSON.stringify({ providerSettings: { codex: false } }));
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => { lines.push(String(chunk)); return true; });
  assert.equal(await handleUserMessage(f.client as never, f.message, undefined, 'controller'), 'rejected');
  const receipt = f.said.find(item => (item as { type?: string }).type === 'delivery.receipt') as
    { messageId?: string; status?: string; error?: string } | undefined;
  assert.deepEqual([receipt?.messageId, receipt?.status, receipt?.error],
    ['parent', 'rejected', 'Codex is disabled in GrantTap Settings.'], 'the bubble carries the reason, not only a passing note');
  assert.ok(lines.some(line => line === '[monitor] A new Codex task from the phone was refused: Codex is disabled in GrantTap Settings.\n'));
  assert.ok(!lines.some(line => line.includes('Synthetic task')), 'the log never carries the person\'s words');
  assert.equal(f.registry.lookup(f.scope, 'codex').state, 'failed', 'a follow-up fails instead of waiting for a chat');
  const followUp = resolveTaskOriginJob(f.registry, { jobId: 'follow-up', operation: { type: 'user.message.continue',
    originMessageId: 'parent', agent: 'codex', text: 'And now?', createdAt: 3 } } as never, 'room', 'controller');
  assert.equal(followUp.state, 'failed');
  f.registry.refuse(f.scope, f.message);
  assert.equal(f.registry.lookup(f.scope, 'codex').state, 'failed', 'a second refusal changes nothing');
  assert.equal(f.registry.begin(f.scope, { ...f.message, attachments: [], retryId: 'retry-1' }).state, 'started',
    'a retry from the phone starts afresh, whatever it now carries');
});
