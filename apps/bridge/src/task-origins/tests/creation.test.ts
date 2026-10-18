import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { handleUserMessage } from '../../monitor/handlers/user-message';
import { TaskOriginRegistry } from '../index';

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
  assert.match(f.said.at(-1)?.text ?? '', /Could not create/);
});
