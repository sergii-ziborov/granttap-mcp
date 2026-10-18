import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateKeyPair } from '../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../packages/protocol/schema';
import { TaskDispatchInbox } from '../../task-dispatch';
import { TaskDispatchWorker, type WorkerOptions } from '../../task-dispatch/worker';
import { TaskOriginRegistry, resolveTaskOriginJob } from '../index';

for (const agent of ['codex', 'claude', 'cursor', 'grok'] as const) {
  test(`${agent}: a saved follow-up survives the phone exiting before its native chat exists`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'granttap-continuation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const peer = generateKeyPair().publicKey, room = 'fixture-room', now = Date.now();
    const origins = new TaskOriginRegistry(join(root, 'origins'));
    const inbox = new TaskDispatchInbox(join(root, 'inbox'), room);
    const origin = { room, peerPublicKey: peer, originMessageId: 'parent-message' };
    const message = { type: 'user.message' as const, messageId: 'parent-message', taskOriginId: 'parent-message',
      text: 'Synthetic parent', createdAt: now, agent, projectId: 'project' };
    const job: TaskDispatch = { type: 'task.dispatch', jobId: 'continuation-job', token: 'a'.repeat(64),
      notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
      operation: { type: 'user.message.continue', messageId: 'continuation-job', originMessageId: 'parent-message',
        text: 'Synthetic continuation', createdAt: now, agent } };
    inbox.stage(job, peer);
    let starts = 0, claims = 0, remoteState = 'queued';
    const options: WorkerOptions = { inbox, connected: () => true, authorized: key => key === peer,
      ready: (queued, key) => !!resolveTaskOriginJob(origins, queued, room, key).job,
      remote: { get: async () => remoteState, claim: async () => { claims++; return true; },
        finish: async (_job, state) => { remoteState = state; } },
      deliver: async (queued, beforeStart, key) => {
        const resolved = resolveTaskOriginJob(origins, queued, room, key).job!;
        assert.equal(resolved.operation.type, 'user.message');
        assert.equal(resolved.sessionId, 'native-chat');
        assert.equal(resolved.operation.projectId, 'project');
        assert.equal(resolved.operation.agent, agent);
        await beforeStart(); starts++; return 'accepted';
      } };
    await new TaskDispatchWorker(options).tick();
    assert.equal(claims, 0, 'unknown origins remain safely queued on relay');
    origins.begin(origin, message);
    await new TaskDispatchWorker(options).tick();
    assert.equal(starts, 0, 'a native ID is required, even when the parent has started');
    origins.complete(origin, { ok: true, sessionId: 'native-chat' });
    await new TaskDispatchWorker({ ...options, inbox: new TaskDispatchInbox(join(root, 'inbox'), room) }).tick();
    await new TaskDispatchWorker(options).tick();
    assert.equal(starts, 1); assert.equal(remoteState, 'completed');
    assert.equal(resolveTaskOriginJob(origins, job, room, generateKeyPair().publicKey).state, 'waiting');
    const normal = { ...job, sessionId: 'native-chat', operation: { type: 'user.message' as const,
      sessionId: 'native-chat', text: 'Synthetic existing message', createdAt: now } };
    assert.equal(resolveTaskOriginJob(origins, normal, room, peer).job, normal);
  });
}

test('worker validation preserves an uncertain origin without launching a new native task', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-uncertain-origin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const peer = generateKeyPair().publicKey, now = Date.now();
  const inbox = new TaskDispatchInbox(join(root, 'inbox'), 'room');
  const job: TaskDispatch = { type: 'task.dispatch', jobId: 'uncertain-job', token: 'a'.repeat(64),
    notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
    operation: { type: 'user.message.continue', messageId: 'uncertain-job', originMessageId: 'parent',
      agent: 'codex', text: 'Synthetic follow-up', createdAt: now } };
  inbox.stage(job, peer);
  let starts = 0, code: string | undefined;
  await new TaskDispatchWorker({ inbox, connected: () => true, authorized: () => true,
    conversationKey: () => 'parent', validationCode: () => 'confirmation_required', ready: () => true,
    remote: { get: async () => 'queued', claim: async () => true,
      finish: async (_job, _state, result) => { code = result; } },
    deliver: async () => { starts++; return 'accepted'; } }).tick();
  assert.equal(starts, 0); assert.equal(code, 'confirmation_required');
});
