import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { open } from '../../../../../../packages/core/crypto';
import { PeerTaskDispatch, PeerTaskResult } from '../../../../../../packages/protocol/task-network';
import { TaskNetworkStore } from '../../index';
import { TransferContinuations } from '../../../task-transfer';
import { PeerTransferOutbox } from '../../storage/outgoing';
import { networkEnvelope } from '../../transport/ciphertext';
import { handoffReceipt } from '../../../mesh/handoff';
import { networkFixture } from '../../tests/fixture';
import { PeerTransferSender } from '../index';

test('a computer queues one immutable transfer, guards its source before upload and retires only after an authenticated receipt', async () => {
  const f = networkFixture();
  try {
    const network = new TaskNetworkStore(join(f.root, 'source-peers'), 'source', f.source.publicKey);
    network.configure({ ...f.targetNetwork, targetEndpointId: 'source', peers: [f.peer] }, f.controller.publicKey, () => true);
    const outbox = new PeerTransferOutbox(join(f.root, 'outgoing'));
    const notices = new TransferContinuations(join(f.root, 'source-notices'));
    let current: PeerTaskDispatch | undefined, applied = 0, requests = 0;
    const bodies: unknown[] = [];
    const options = { config: f.sourceConfig, network, outbox, notices, controllerAllowed: () => true,
      recordRequest: () => {},
      onResult: async (result: PeerTaskResult) => {
        applied++;
        const receipt = result.event.payload.receipt!;
        notices.record({ sourceSessionId: receipt.sourceSessionId, targetSessionId: receipt.targetSessionId,
          projectId: 'project', taskId: 'task', capsuleHash: receipt.capsuleHash,
          queuedAt: f.now, acceptedAt: receipt.acceptedAt });
      },
      remote: async (_peer: unknown, id: string, method: string, body?: any) => {
        requests++;
        assert.ok(notices.blockReason('source-chat'), 'Source admission must be durable before any upload.');
        if (method === 'PUT') {
          bodies.push(body);
          current = PeerTaskDispatch.parse(open(body.envelope.nonce, body.envelope.box, f.source.publicKey, f.target.secretKey));
          if (bodies.length === 1) throw new Error('Synthetic ambiguous upload');
          return { id, state: 'queued' as const };
        }
        const receipt = handoffReceipt(current!.operation.event.payload.capsule!, 'source-chat', 'prepared-target', f.now + 1);
        receipt.prepared = true;
        const result = PeerTaskResult.parse({ type: 'mesh.task.result', jobId: id, projectId: 'project', taskId: 'task',
          destination: { sessionId: 'prepared-target', taskId: 'task', provider: 'grok', computerId: 'target',
            workspace: '/fixture/remote/worktree', startedAt: f.now + 1 },
          event: { type: 'mesh.event', sessionId: 'task', eventId: 'peer-receipt', projectId: 'project', taskId: 'task',
            sourceSessionId: 'prepared-target', targetSessionId: 'source-chat', eventType: 'HANDOFF_ACCEPTED',
            createdAt: f.now + 1, payload: { receipt } } });
        return { id, state: 'completed' as const, resultEnvelope: networkEnvelope(f.targetConfig, {
          publicKey: f.source.publicKey, room: f.targetConfig.room, body: result, id, expiresAt: f.now + 60_000 }) };
      } };
    const sender = new PeerTransferSender(options);
    assert.equal(await sender.submit(f.job.operation, async () => true), true);
    assert.equal(outbox.pending()[0]?.state, 'uploading');
    await new PeerTransferSender(options).tick();
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(outbox.pending()[0]?.state, 'queued');
    await new PeerTransferSender(options).tick();
    assert.equal(applied, 1); assert.equal(requests, 3);
    assert.equal(notices.notice('source-chat')?.targetSessionId, 'prepared-target');
    assert.deepEqual(outbox.pending(), []);
  } finally { f.cleanup(); }
});

test('a changed source after capture withdraws an uncommitted draft without uploading context', async () => {
  const f = networkFixture();
  try {
    const network = new TaskNetworkStore(join(f.root, 'source-peers'), 'source', f.source.publicKey);
    network.configure({ ...f.targetNetwork, targetEndpointId: 'source', peers: [f.peer] }, f.controller.publicKey, () => true);
    const outbox = new PeerTransferOutbox(join(f.root, 'outgoing'));
    const notices = new TransferContinuations(join(f.root, 'source-notices'));
    let requests = 0;
    const sender = new PeerTransferSender({ config: f.sourceConfig, network, outbox, notices,
      controllerAllowed: () => true, recordRequest: () => {}, onResult: async () => {},
      remote: async () => { requests++; throw new Error('Must not upload'); } });
    await assert.rejects(sender.submit(f.job.operation, async () => false), /changed|capture/i);
    assert.equal(requests, 0);
    assert.equal(notices.notice('source-chat'), undefined);
    assert.deepEqual(outbox.pending(), []);
  } finally { f.cleanup(); }
});
