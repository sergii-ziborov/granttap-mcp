import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { open } from '../../../../../../packages/core/crypto';
import { TaskNetworkStore } from '../../index';
import { TransferContinuations } from '../../../task-transfer';
import { handoffReceipt } from '../../../mesh/handoff';
import { PeerTransferOutbox } from '../../storage/outgoing';
import { networkEnvelope } from '../../transport/ciphertext';
import { networkFixture } from '../../tests/fixture';
import { PeerTransferSender } from '../index';

test('a signed receipt without the selected destination execution never unlocks or retires the source transfer', async () => {
  for (const destination of [undefined, { taskId: 'task', sessionId: 'target-chat', computerId: 'different-computer',
    provider: 'grok', workspace: '/unconfirmed/path', startedAt: Date.now() }]) {
    const f = networkFixture();
    try {
      const network = new TaskNetworkStore(join(f.root, 'peers'), 'source', f.source.publicKey);
      network.configure({ ...f.targetNetwork, targetEndpointId: 'source', peers: [f.peer] }, f.controller.publicKey, () => true);
      const outbox = new PeerTransferOutbox(join(f.root, 'outbox'));
      const notices = new TransferContinuations(join(f.root, 'notices'));
      let applied = 0;
      const sender = new PeerTransferSender({ config: f.sourceConfig, network, outbox, notices, controllerAllowed: () => true,
        recordRequest: () => {}, onResult: async () => { applied++; },
        remote: async (_peer, id, _method, body: any) => {
          const job: any = open(body.envelope.nonce, body.envelope.box, f.source.publicKey, f.target.secretKey);
          const receipt = handoffReceipt(job.operation.event.payload.capsule, 'source-chat', 'target-chat', f.now + 1);
          receipt.prepared = true;
          const result = { type: 'mesh.task.result', jobId: id, projectId: 'project', taskId: 'task', destination,
            event: { type: 'mesh.event', sessionId: 'task', eventId: 'invalid-target', projectId: 'project', taskId: 'task',
              sourceSessionId: 'target-chat', targetSessionId: 'source-chat', eventType: 'HANDOFF_ACCEPTED',
              createdAt: f.now + 1, payload: { receipt } } };
          return { id, state: 'completed', resultEnvelope: networkEnvelope(f.targetConfig, {
            publicKey: f.source.publicKey, room: f.targetConfig.room, body: result, id, expiresAt: f.now + 60_000 }) };
        } });
      await sender.submit(f.job.operation, async () => true);
      assert.equal(applied, 0);
      assert.equal(outbox.pending().length, 1);
      assert.equal(notices.notice('source-chat')?.phase, 'pending');
    } finally { f.cleanup(); }
  }
});
