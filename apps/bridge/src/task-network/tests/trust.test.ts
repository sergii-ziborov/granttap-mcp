import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { generateKeyPair, seal } from '../../../../../packages/core/crypto';
import { publicKeyIdentifier } from '../../../../../packages/core/ciphertext-recipient';
import { TaskNetworkStore, taskNetworkScope } from '../index';
import { openPeerTaskOffer } from '../transport/receive';

test('Project network grants are durable, monotonic, revocable, and never controller grants', () => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-task-peers-'));
  try {
    const source = generateKeyPair(), target = generateKeyPair(), now = Date.now();
    const store = new TaskNetworkStore(directory, 'target', target.publicKey);
    const config = { type: 'project.transport.set' as const, sessionId: 'project', projectId: 'project',
      targetEndpointId: 'target', requestId: 'request', revision: 1, createdAt: now,
      enabled: true, expiresAt: now + 60_000, allowCrossPlatform: false, cooldownMs: 60_000,
      peers: [{ endpointId: 'source', publicKey: source.publicKey, incomingWriterId: 'writer-source-to-target',
        outgoing: { room: 'b'.repeat(32), relayUrl: 'wss://relay.test', writerId: 'writer-target-to-source',
          secret: 'c'.repeat(64), scopeHash: taskNetworkScope('project', 'target', 'source', 1), expiresAt: now + 60_000 } }] };
    assert.equal(store.configure(config, 'controller-key', () => true, now), true);
    assert.equal(new TaskNetworkStore(directory, 'target', target.publicKey).current('project', () => true, now)?.peers.length, 1);
    assert.equal(store.current('project', () => false, now), undefined);
    assert.equal(store.configure({ ...config, projectId: 'another' }, 'controller-key', () => true, now), false);
    assert.equal(store.configure({ ...config, revision: 0 }, 'controller-key', () => true, now), false);
    const disabled = { ...config, enabled: false, peers: [], revision: 2, createdAt: now + 1 };
    assert.equal(store.configure(disabled, 'controller-key', () => true, now), true);
    assert.equal(store.configure(config, 'controller-key', () => true, now), false);
    assert.equal(store.current('project', () => true, now), undefined);
    assert.equal(store.current('project', () => true, now + 61_000), undefined);
    assert.equal('controllers' in store, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a peer queue accepts only ciphertext from its current Project writer and refuses controller operations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-task-peer-crypto-'));
  try {
    const source = generateKeyPair(), target = generateKeyPair(), controller = generateKeyPair(), now = Date.now();
    const store = new TaskNetworkStore(directory, 'target', target.publicKey);
    const configuration = { type: 'project.transport.set' as const, sessionId: 'project', projectId: 'project',
      targetEndpointId: 'target', requestId: 'request', revision: 1, createdAt: now,
      enabled: true, expiresAt: now + 60_000, allowCrossPlatform: false, cooldownMs: 60_000,
      peers: [{ endpointId: 'source', publicKey: source.publicKey, incomingWriterId: 'incoming-peer-writer',
        outgoing: { room: 'b'.repeat(32), relayUrl: 'wss://relay.test', writerId: 'outgoing-peer-writer',
          secret: 'c'.repeat(64), scopeHash: taskNetworkScope('project', 'target', 'source', 1), expiresAt: now + 60_000 } }] };
    assert.ok(store.configure(configuration, controller.publicKey, () => true, now));
    const context = 'Synthetic visible conversation';
    const capsule = { taskId: 'task', title: 'Original title', launch: 'on_message',
      contextHash: createHash('sha256').update(context).digest('hex'), goal: 'Synthetic task',
      currentStatus: 'Ready', sourceProvider: 'codex', sourceComputer: 'source', targetProvider: 'grok',
      targetComputer: 'target', repository: 'repo', baseSha: 'a'.repeat(40), filesChanged: [],
      dependencies: [], resourceClaims: [], remainingWork: [], importantDecisions: [], createdAt: now };
    const event = { type: 'mesh.event', sessionId: 'task', eventId: 'transfer-event', projectId: 'project',
      taskId: 'task', sourceSessionId: 'source-chat', eventType: 'HANDOFF_REQUEST', createdAt: now,
      payload: { capsule, transferContext: context } };
    const operation = { type: 'mesh.task.transfer', projectId: 'project', taskId: 'task', policyRevision: 1,
      task: { taskId: 'task', projectId: 'project', title: 'Original title', goal: 'Synthetic task',
        state: 'working', ownerSessionId: 'source-chat', createdAt: now, updatedAt: now },
      sourceExecution: { taskId: 'task', sessionId: 'source-chat', provider: 'codex', computerId: 'source',
        workspace: '/fixture', startedAt: now }, event };
    const job = { type: 'mesh.task.dispatch', jobId: 'peer-task-job-0001', token: 'd'.repeat(64),
      notBefore: now, expiresAt: now + 30_000, createdAt: now, operation };
    const config = { ...target, myPublicKey: target.publicKey, mySecretKey: target.secretKey,
      peerPublicKey: controller.publicKey, relayUrl: 'wss://relay.test', room: 'a'.repeat(32),
      role: 'machine' as const, senderId: 'target', deviceName: 'Target' };
    const offer = (value: unknown, key = source.secretKey) => ({ type: 'relay.task-job', job: {
      id: job.jobId, state: 'queued', notBefore: now, expiresAt: job.expiresAt, writerId: 'incoming-peer-writer',
      envelope: { v: 1, room: config.room, from: 'machine', to: 'machine', senderId: 'source',
        deliveryId: job.jobId, recipientKeyId: publicKeyIdentifier(target.publicKey), expiresAt: job.expiresAt,
        ...seal(value, target.publicKey, key) } } });
    assert.equal(openPeerTaskOffer(offer(job), config, store, () => true, now)?.job.operation.taskId, 'task');
    assert.equal(openPeerTaskOffer(offer(job, controller.secretKey), config, store, () => true, now), undefined);
    assert.equal(openPeerTaskOffer(offer(job), config, store, () => false, now), undefined);
    assert.equal(openPeerTaskOffer(offer({ ...job, operation: { ...operation, projectId: 'another' } }), config, store, () => true, now), undefined);
    assert.equal(openPeerTaskOffer(offer({ ...job, operation: { type: 'config.set', autoApprove: true } }), config, store, () => true, now), undefined);
    assert.equal(openPeerTaskOffer(offer(job), config, store, () => true, now + 31_000), undefined);
    store.configure({ ...configuration, enabled: false, peers: [], revision: 2, createdAt: now + 1 }, controller.publicKey, () => true, now);
    assert.equal(openPeerTaskOffer(offer(job), config, store, () => true, now), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
