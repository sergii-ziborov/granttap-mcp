import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { TaskNetworkStore } from '../../index';
import { TransferContinuations } from '../../../task-transfer';
import { capsuleHash, handoffReceipt } from '../../../mesh/handoff';
import { PeerTransferOutbox } from '../../storage/outgoing';
import { networkEnvelope, peerJobBody, openPeerResult } from '../../transport/ciphertext';
import { PeerTaskResult } from '../../../../../../packages/protocol/task-network';
import { networkFixture } from '../../tests/fixture';
import { PeerTransferSender } from '../index';

test('a restarted sender never uploads a draft whose source capture was not confirmed', async () => {
  const f = networkFixture();
  try {
    const network = new TaskNetworkStore(join(f.root, 'source-peers'), 'source', f.source.publicKey);
    network.configure({ ...f.targetNetwork, targetEndpointId: 'source', peers: [f.peer] }, f.controller.publicKey, () => true);
    const outbox = new PeerTransferOutbox(join(f.root, 'outgoing'));
    const notices = new TransferContinuations(join(f.root, 'notices'));
    const capsule = f.job.operation.event.payload.capsule!;
    outbox.stage({ id: f.job.jobId, projectId: 'project', taskId: 'task', eventId: 'transfer-event',
      sourceSessionId: 'source-chat', capsule, peer: f.peer, targetEndpointId: 'target',
      writerId: f.peer.outgoing.writerId, revision: 1, createdAt: f.now, expiresAt: f.job.expiresAt },
    f.job.operation, () => peerJobBody(f.sourceConfig, f.peer, f.job));
    notices.record({ phase: 'pending', projectId: 'project', taskId: 'task', sourceSessionId: 'source-chat',
      capsuleHash: capsuleHash(capsule), queuedAt: f.now, targetComputerId: 'target' });
    let requests = 0;
    const sender = new PeerTransferSender({ config: f.sourceConfig, network, outbox, notices,
      controllerAllowed: () => true, recordRequest: () => {}, onResult: async () => {},
      remote: async () => { requests++; return { id: f.job.jobId, state: 'queued' }; } });
    await sender.tick();
    assert.equal(requests, 0, 'Only explicit capture confirmation may activate the ciphertext.');
    assert.equal(outbox.header(f.job.jobId).state, 'drafting');
    assert.ok(notices.blockReason('source-chat'));
  } finally { f.cleanup(); }
});

test('a saved authenticated receipt remains readable during bounded offline recovery', () => {
  const f = networkFixture();
  try {
    const receipt = handoffReceipt(f.job.operation.event.payload.capsule!, 'source-chat', 'destination', f.now);
    receipt.prepared = true;
    const result = PeerTaskResult.parse({ type: 'mesh.task.result', jobId: f.job.jobId, projectId: 'project', taskId: 'task',
      event: { type: 'mesh.event', sessionId: 'task', projectId: 'project', taskId: 'task', eventId: 'accepted',
        sourceSessionId: 'destination', targetSessionId: 'source-chat', eventType: 'HANDOFF_ACCEPTED',
        createdAt: f.now, payload: { receipt } } });
    const envelope = networkEnvelope(f.targetConfig, { publicKey: f.source.publicKey, room: f.targetConfig.room,
      id: f.job.jobId, body: result, expiresAt: f.now + 1_000 });
    const expected = { jobId: f.job.jobId, projectId: 'project', taskId: 'task', retainedUntil: f.now + 7 * 86_400_000 };
    assert.deepEqual(openPeerResult(envelope, f.sourceConfig, f.peer, expected, f.now + 86_400_000), result);
    assert.equal(openPeerResult(envelope, f.sourceConfig, f.peer, expected, expected.retainedUntil + 1), undefined);
    assert.equal(openPeerResult(envelope, f.sourceConfig, f.peer, { ...expected, taskId: 'other' }, f.now), undefined);
    assert.equal(openPeerResult(envelope, f.sourceConfig, f.peer,
      { jobId: f.job.jobId, projectId: 'project', taskId: 'task' }, f.now + 86_400_000), undefined);
  } finally { f.cleanup(); }
});
