import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateKeyPair, open } from '../../../../../../packages/core/crypto';
import type { PeerConfig } from '../../../../../../packages/core/relay-client';
import type { UserMessage } from '../../../../../../packages/protocol/schema';
import { NativeTaskQueueSender } from '../index';

test('same-computer queue persists one encrypted operation across HTTP failure and process restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-sender-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const machine = generateKeyPair(), controller = generateKeyPair();
  const config: PeerConfig = { relayUrl: 'wss://relay.test', room: 'a'.repeat(32), role: 'machine',
    deviceName: 'Fixture', senderId: 'fixture', myPublicKey: machine.publicKey, mySecretKey: machine.secretKey,
    peerPublicKey: controller.publicKey, pushAuth: 'b'.repeat(64) };
  const now = Date.now(), id = 'native-job-001';
  const scope = { projectId: 'project', taskId: 'task', sessionId: 'chat', provider: 'codex' as const };
  const message: UserMessage = { type: 'user.message', messageId: id, sessionId: 'chat', agent: 'codex',
    projectId: 'project', text: 'Synthetic native queued task', createdAt: now,
    attachments: [{ name: 'photo.png', mimeType: 'image/png', data: 'AQID' }] };
  const uploads: string[] = [];
  const request = async (_url: unknown, init?: RequestInit) => {
    uploads.push(String(init?.body));
    if (uploads.length === 1) return new Response('{}', { status: 503 });
    return Response.json({ job: { id, state: 'queued', notBefore: now, expiresAt: now + 7 * 86_400_000 } });
  };
  const sender = new NativeTaskQueueSender({ root, config, request: request as typeof fetch });
  await assert.rejects(sender.submit(scope, message, now, now, 'immediate'));
  assert.equal(sender.hasStaged(scope, message, now, now, 'immediate'), true);
  assert.equal(sender.hasStaged(scope, message, now, now), false);
  assert.equal(sender.hasStaged(scope, { ...message, text: 'Another task' }, now, now), false);
  assert.equal(sender.hasStaged({ ...scope, taskId: 'foreign' }, message, now, now), false);
  const recovered = new NativeTaskQueueSender({ root, config, request: request as typeof fetch });
  assert.equal((await recovered.submit(scope, message, now, now, 'immediate')).state, 'queued');
  assert.equal(uploads.length, 2); assert.equal(uploads[0], uploads[1]);
  const envelope = JSON.parse(uploads[0]!).envelope;
  const decoded = open(envelope.nonce, envelope.box, config.myPublicKey, config.mySecretKey) as {
    origin: string; operation: UserMessage; deliveryMode: string;
  };
  assert.equal(decoded.origin, 'computer');
  assert.equal(decoded.deliveryMode, 'immediate');
  assert.equal(decoded.operation.attachments?.[0]?.data, 'AQID');
  await assert.rejects(recovered.submit(scope, { ...message, text: 'Conflicting operation' }, now, now));
  await assert.rejects(recovered.status({ ...scope, taskId: 'other-task' }, id));
  assert.equal(uploads.length, 2);
});
