import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { generateKeyPair } from '../../../../../../packages/core/crypto';
import type { PeerConfig } from '../../../../../../packages/core/relay-client';
import type { UserMessage } from '../../../../../../packages/protocol/schema';
import { NativeTaskQueueSender } from '../index';

function fixture(t: TestContext, handle: (method: string) => Response) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-queue-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const machine = generateKeyPair(), controller = generateKeyPair();
  const config: PeerConfig = { relayUrl: 'wss://relay.test', room: 'a'.repeat(32), role: 'machine',
    deviceName: 'Fixture', senderId: 'fixture', myPublicKey: machine.publicKey, mySecretKey: machine.secretKey,
    peerPublicKey: controller.publicKey, pushAuth: 'b'.repeat(64) };
  const now = Date.now(), id = 'cancel-job-001';
  const calls: string[] = [], bodies: string[] = [];
  const request = async (_url: unknown, init?: RequestInit) => {
    calls.push(init?.method ?? 'GET');
    if (init?.body) bodies.push(String(init.body));
    return handle(init?.method ?? 'GET');
  };
  const scope = { projectId: 'project', taskId: 'task', sessionId: 'chat', provider: 'codex' as const };
  const message: UserMessage = { type: 'user.message', messageId: id, sessionId: 'chat', agent: 'codex',
    projectId: 'project', text: 'Synthetic cancellation probe', createdAt: now };
  return { scope, message, now, id, calls, bodies,
    sender: () => new NativeTaskQueueSender({ root, config, request: request as typeof fetch }),
    receipt: (state: string) => Response.json({ job: { id, state, notBefore: now, expiresAt: now + 86_400_000 } }) };
}

test('an uploaded operation cancels directly without waiting for a metadata GET after restart', async t => {
  const f = fixture(t, method => {
    assert.notEqual(method, 'GET', 'Cancellation must not wait for a potentially stalled status read');
    return f.receipt(method === 'DELETE' ? 'cancelled' : 'queued');
  });
  await f.sender().submit(f.scope, f.message, f.now, f.now);
  assert.equal((await f.sender().cancel(f.scope, f.id)).state, 'cancelled');
  assert.equal((await f.sender().cancel(f.scope, f.id)).state, 'cancelled');
  assert.deepEqual(f.calls, ['PUT', 'DELETE', 'DELETE']);
});

test('a claim winning the cancellation race is read after DELETE without another prompt or upload', async t => {
  const f = fixture(t, method => method === 'DELETE' ? new Response('{}', { status: 409 })
    : f.receipt(method === 'GET' ? 'accepted' : 'queued'));
  const sender = f.sender();
  await sender.submit(f.scope, f.message, f.now, f.now);
  assert.equal((await sender.cancel(f.scope, f.id)).state, 'accepted');
  assert.deepEqual(f.calls, ['PUT', 'DELETE', 'GET']);
  assert.equal(f.bodies.length, 1);
});

test('ambiguous upload is reconciled with identical ciphertext before direct cancellation', async t => {
  const f = fixture(t, method => f.calls.length === 1 ? new Response('{}', { status: 503 })
    : f.receipt(method === 'DELETE' ? 'cancelled' : 'queued'));
  await assert.rejects(f.sender().submit(f.scope, f.message, f.now, f.now));
  assert.equal((await f.sender().cancel(f.scope, f.id)).state, 'cancelled');
  assert.deepEqual(f.calls, ['PUT', 'PUT', 'DELETE']);
  assert.equal(f.bodies[0], f.bodies[1]);
});

test('a lost DELETE response retains the original operation for cancellation after process restart', async t => {
  let deletes = 0;
  const f = fixture(t, method => method === 'DELETE' && ++deletes === 1
    ? new Response('{}', { status: 503 }) : f.receipt(method === 'DELETE' ? 'cancelled' : 'queued'));
  await f.sender().submit(f.scope, f.message, f.now, f.now);
  await assert.rejects(f.sender().cancel(f.scope, f.id));
  assert.equal((await f.sender().cancel(f.scope, f.id)).state, 'cancelled');
  assert.deepEqual(f.calls, ['PUT', 'DELETE', 'DELETE']);
  assert.equal(f.bodies.length, 1);
});

test('another Task cannot cancel an uploaded operation or trigger any relay request', async t => {
  const f = fixture(t, () => f.receipt('queued'));
  const sender = f.sender();
  await sender.submit(f.scope, f.message, f.now, f.now);
  await assert.rejects(sender.cancel({ ...f.scope, taskId: 'foreign-task' }, f.id));
  assert.deepEqual(f.calls, ['PUT']);
});
