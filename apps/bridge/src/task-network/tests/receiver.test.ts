import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PeerTaskResult } from '../../../../../packages/protocol/task-network';
import { handoffReceipt } from '../../mesh/handoff';
import { PeerTransferInbox } from '../storage/incoming';
import { PeerTransferReceiver } from '../runtime/receiver';
import { openPeerResult } from '../transport/ciphertext';
import { networkFixture } from './fixture';
import { PreparedTaskTransfers } from '../../task-transfer';

test('an interrupted relay finish recovers the saved transfer result without preparing or forwarding work twice', async () => {
  const f = networkFixture();
  try {
    const path = join(f.root, 'incoming'), inbox = new PeerTransferInbox(path);
    inbox.stage(f.job, f.source.publicKey, f.peer.outgoing.writerId);
    let prepares = 0, claims = 0, finishes = 0;
    const options = { config: f.targetConfig, store: f.store, inbox,
      controllerAllowed: () => true, enabled: () => true, online: () => true,
      prepare: async () => {
        prepares++;
        const receipt = handoffReceipt(f.job.operation.event.payload.capsule!, 'source-chat', 'prepared-target', f.now);
        receipt.prepared = true;
        return PeerTaskResult.parse({ type: 'mesh.task.result', jobId: f.job.jobId, projectId: 'project', taskId: 'task',
          event: { type: 'mesh.event', sessionId: 'task', eventId: 'accepted-peer-transfer', projectId: 'project',
            taskId: 'task', sourceSessionId: 'prepared-target', targetSessionId: 'source-chat',
            eventType: 'HANDOFF_ACCEPTED', createdAt: f.now, payload: { receipt } } });
      },
      remote: async (id: string, action: 'claim' | 'finish', proof: any) => {
        if (action === 'claim') { claims++; return { id, state: 'accepted' as const }; }
        finishes++;
        const opened = openPeerResult(proof.resultEnvelope, f.sourceConfig, f.peer,
          { jobId: id, projectId: 'project', taskId: 'task' });
        assert.equal(opened?.event.payload.receipt?.targetSessionId, 'prepared-target');
        if (finishes === 1) throw new Error('Synthetic lost finish response');
        return { id, state: 'completed' as const };
      } };
    await new PeerTransferReceiver(options).tick();
    assert.equal(inbox.header(f.job.jobId).phase, 'result');
    assert.ok(existsSync(join(path, `${f.job.jobId}.request.json`)));
    await new PeerTransferReceiver({ ...options, inbox: new PeerTransferInbox(path) }).tick();
    assert.equal(prepares, 1); assert.equal(claims, 1); assert.equal(finishes, 2);
    assert.equal(inbox.header(f.job.jobId).phase, 'completed');
    assert.equal(existsSync(join(path, `${f.job.jobId}.request.json`)), false);
  } finally { f.cleanup(); }
});

test('revocation after an interrupted preparation recovers the existing destination instead of falsely reporting no work', async () => {
  const f = networkFixture();
  try {
    const inbox = new PeerTransferInbox(join(f.root, 'incoming'));
    const transfers = new PreparedTaskTransfers(join(f.root, 'prepared'));
    inbox.stage(f.job, f.source.publicKey, f.peer.outgoing.writerId);
    let prepares = 0, recoveries = 0, final: string | undefined;
    const options = { config: f.targetConfig, store: f.store, inbox,
      controllerAllowed: () => true, enabled: () => true, online: () => true,
      prepare: async () => {
        prepares++;
        const operation = f.job.operation;
        transfers.prepare({ eventId: operation.event.eventId, projectId: 'project', sourceSessionId: 'source-chat',
          title: 'Task', capsule: operation.event.payload.capsule!, context: operation.event.payload.transferContext!,
          workspace: '/fixture/target', branch: 'granttap/target', acceptedAt: f.now });
        throw new Error('Synthetic interruption after durable preparation');
      },
      recover: async () => {
        recoveries++;
        const prepared = transfers.forEvent(f.job.operation.event.eventId)!;
        const receipt = handoffReceipt(prepared.capsule, 'source-chat', prepared.sessionId, prepared.acceptedAt);
        receipt.prepared = true;
        return PeerTaskResult.parse({ type: 'mesh.task.result', jobId: f.job.jobId, projectId: 'project', taskId: 'task',
          event: { type: 'mesh.event', sessionId: 'task', eventId: 'recovered-peer-transfer', projectId: 'project', taskId: 'task',
            sourceSessionId: prepared.sessionId, targetSessionId: 'source-chat', eventType: 'HANDOFF_ACCEPTED',
            createdAt: f.now, payload: { receipt } } });
      },
      remote: async (id: string, action: 'claim' | 'finish', proof: any) => {
        if (action === 'claim') return { id, state: 'accepted' as const };
        final = proof.state;
        return { id, state: proof.state as 'completed' | 'failed' };
      } };
    const receiver = new PeerTransferReceiver(options);
    await receiver.tick();
    f.store.configure({ ...f.targetNetwork, enabled: false, peers: [], revision: 2,
      createdAt: f.now + 1 }, f.controller.publicKey, () => true);
    await receiver.tick();
    assert.equal(prepares, 1); assert.equal(recoveries, 1);
    assert.equal(final, 'completed');
    assert.equal(inbox.result(f.job.jobId).accepted, true);
  } finally { f.cleanup(); }
});

test('Project revocation between durable admission and preparation prevents execution', async () => {
  const f = networkFixture();
  try {
    const inbox = new PeerTransferInbox(join(f.root, 'incoming'));
    inbox.stage(f.job, f.source.publicKey, f.peer.outgoing.writerId);
    let prepares = 0, final: string | undefined;
    await new PeerTransferReceiver({ config: f.targetConfig, store: f.store, inbox,
      controllerAllowed: () => true, enabled: () => true, online: () => true,
      prepare: async () => { prepares++; throw new Error('Must not start'); },
      remote: async (id, action, proof) => {
        if (action === 'claim') {
          f.store.configure({ ...f.targetNetwork, enabled: false, peers: [], revision: 2,
            createdAt: f.now + 1 }, f.controller.publicKey, () => true);
          return { id, state: 'accepted' };
        }
        final = proof.state;
        assert.equal(proof.resultCode, 'policy_denied');
        assert.equal(openPeerResult(proof.resultEnvelope, f.sourceConfig, f.peer,
          { jobId: id, projectId: 'project', taskId: 'task' })?.event.eventType, 'HANDOFF_REJECTED');
        return { id, state: 'failed' };
      } }).tick();
    assert.equal(prepares, 0); assert.equal(final, 'failed');
    assert.equal(inbox.header(f.job.jobId).phase, 'completed');
  } finally { f.cleanup(); }
});
