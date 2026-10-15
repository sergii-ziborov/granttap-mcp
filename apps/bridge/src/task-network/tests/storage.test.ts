import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PeerTransferOutbox } from '../storage/outgoing';
import { PeerTransferInbox } from '../storage/incoming';
import { peerJobBody, networkEnvelope } from '../transport/ciphertext';
import { networkFixture } from './fixture';

test('outgoing transfer retries preserve the same ciphertext and retire it only after a confirmed outcome', () => {
  const f = networkFixture();
  try {
    const path = join(f.root, 'outgoing'), store = new PeerTransferOutbox(path);
    const header = { id: f.job.jobId, projectId: 'project', taskId: 'task', eventId: 'transfer-event',
      sourceSessionId: f.job.operation.sourceExecution.sessionId, capsule: f.job.operation.event.payload.capsule!,
      peer: f.peer,
      targetEndpointId: 'target', writerId: f.peer.outgoing.writerId, revision: 1, createdAt: f.now, expiresAt: f.job.expiresAt };
    let seals = 0;
    const create = () => { seals++; return peerJobBody(f.sourceConfig, f.peer, f.job); };
    assert.equal(store.stage(header, f.job.operation, create).state, 'drafting');
    const saved = store.body(header.id);
    const restarted = new PeerTransferOutbox(path);
    restarted.stage(header, f.job.operation, create);
    assert.equal(seals, 1);
    assert.deepEqual(restarted.body(header.id), saved);
    assert.throws(() => restarted.stage({ ...header, id: 'second-peer-transfer' },
      { ...f.job.operation, other: true }, create), /pending|confirm/i);
    assert.throws(() => restarted.stage({ ...header, taskId: 'foreign' }, f.job.operation, create), /identity|different/i);
    assert.equal(restarted.activate(header.id).state, 'uploading');
    restarted.state(header.id, 'accepted');
    assert.ok(existsSync(join(path, `${header.id}.cipher.json`)));
    restarted.state(header.id, 'completed');
    assert.equal(existsSync(join(path, `${header.id}.cipher.json`)), false);
    assert.deepEqual(new PeerTransferOutbox(path).pending(), []);
    assert.equal(statSync(join(path, `${header.id}.header.json`)).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('receiver stores context before claiming, keeps one preparation owner, and retires full context after relay confirmation', () => {
  const f = networkFixture();
  try {
    const path = join(f.root, 'incoming'), store = new PeerTransferInbox(path);
    const first = store.stage(f.job, f.source.publicKey, f.peer.outgoing.writerId);
    const restarted = new PeerTransferInbox(path);
    assert.equal(restarted.stage(f.job, f.source.publicKey, f.peer.outgoing.writerId).claimId, first.claimId);
    assert.deepEqual(restarted.record(first.id).job, f.job);
    const owner = `${process.pid}:first`;
    assert.ok(store.acquire(first.id, owner));
    assert.equal(restarted.acquire(first.id, `${process.pid}:second`), false);
    const envelope = networkEnvelope(f.targetConfig, { publicKey: f.source.publicKey,
      room: f.targetConfig.room, body: { synthetic: true }, id: first.id, expiresAt: f.job.expiresAt });
    assert.throws(() => restarted.saveResult(first.id, 'foreign', { envelope, accepted: true }), /owner/);
    store.saveResult(first.id, owner, { envelope, accepted: true });
    assert.deepEqual(restarted.result(first.id).envelope, envelope);
    assert.ok(existsSync(join(path, `${first.id}.request.json`)));
    restarted.complete(first.id);
    assert.equal(existsSync(join(path, `${first.id}.request.json`)), false);
    assert.equal(store.stage(f.job, f.source.publicKey, f.peer.outgoing.writerId).phase, 'completed');
    assert.equal(existsSync(join(path, `${first.id}.request.json`)), false);
    assert.deepEqual(store.pending(), []);
  } finally { f.cleanup(); }
});
