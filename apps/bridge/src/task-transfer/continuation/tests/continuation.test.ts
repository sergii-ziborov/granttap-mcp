import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { TransferContinuations } from '../index';

test('continuing a transferred source requires the current receipt and never pauses its destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-continuation-'));
  try {
    const store = new TransferContinuations(root);
    const notice = { sourceSessionId: 'source', targetSessionId: 'target', projectId: 'project',
      taskId: 'task', capsuleHash: 'a'.repeat(64), acceptedAt: 1 };
    store.record(notice);
    assert.ok(store.blockReason('source'));
    assert.equal(store.continue({ sessionId: 'source', projectId: 'wrong', taskId: 'task', capsuleHash: notice.capsuleHash }), false);
    assert.equal(store.continue({ sessionId: 'source', projectId: 'project', taskId: 'task', capsuleHash: 'b'.repeat(64) }), false);
    assert.equal(store.continue({ sessionId: 'source', projectId: 'project', taskId: 'task', capsuleHash: notice.capsuleHash }), true);
    assert.equal(new TransferContinuations(root).blockReason('source'), undefined);
    assert.equal(store.notice('target'), undefined);
    store.record(notice);
    assert.equal(store.blockReason('source'), undefined, 'Receipt replay must not undo explicit consent.');
    store.record({ ...notice, targetSessionId: 'another-target', capsuleHash: 'c'.repeat(64), acceptedAt: 3 });
    assert.ok(store.blockReason('source'), 'A later transfer needs its own confirmation.');
    store.record(notice);
    assert.equal(store.notice('source')?.targetSessionId, 'another-target');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a queued transfer guards the source immediately and preserves explicit parallel consent when the destination confirms', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-pending-transfer-'));
  try {
    const store = new TransferContinuations(root);
    const pending = { phase: 'pending' as const, sourceSessionId: 'source', projectId: 'project', taskId: 'task',
      capsuleHash: 'a'.repeat(64), queuedAt: 10, targetComputerId: 'target-computer', targetProvider: 'grok' };
    store.record(pending);
    assert.equal(store.withdrawPending({ sessionId: 'source', projectId: 'foreign', taskId: 'task', capsuleHash: pending.capsuleHash }), false);
    assert.ok(store.blockReason('source'));
    assert.equal(store.notice('source')?.targetSessionId, undefined);
    assert.ok(store.continue({ sessionId: 'source', projectId: 'project', taskId: 'task', capsuleHash: pending.capsuleHash }));
    const consent = store.notice('source')?.continuedAt;
    store.record({ sourceSessionId: 'source', projectId: 'project', taskId: 'task', queuedAt: 10,
      capsuleHash: pending.capsuleHash, acceptedAt: 9, targetSessionId: 'actual-target-chat' });
    assert.equal(store.notice('source')?.targetSessionId, 'actual-target-chat');
    assert.equal(store.notice('source')?.continuedAt, consent);
    store.record({ ...pending, capsuleHash: 'b'.repeat(64), queuedAt: 20 });
    assert.ok(store.blockReason('source'));
    store.record({ sourceSessionId: 'source', projectId: 'project', taskId: 'task', queuedAt: 10,
      capsuleHash: pending.capsuleHash, acceptedAt: 100, targetSessionId: 'actual-target-chat' });
    assert.equal(store.notice('source')?.capsuleHash, 'b'.repeat(64));
    assert.ok(store.withdrawPending({ sessionId: 'source', projectId: 'project', taskId: 'task', capsuleHash: 'b'.repeat(64) }));
    assert.equal(store.blockReason('source'), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a transferred virtual execution also guards its native provider chat until scoped continuation', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-continuation-alias-'));
  try {
    const store = new TransferContinuations(root);
    const notice = { sourceSessionId: 'virtual-source', targetSessionId: 'target', projectId: 'project',
      taskId: 'task', capsuleHash: 'a'.repeat(64), acceptedAt: 1 };
    store.record(notice, 'native-source');
    assert.ok(new TransferContinuations(root).blockReason('native-source'));
    assert.equal(store.continue({ sessionId: 'native-source', projectId: 'project',
      taskId: 'task', capsuleHash: notice.capsuleHash }), false, 'Consent names the stable visible execution.');
    assert.ok(store.continue({ sessionId: notice.sourceSessionId, projectId: 'project',
      taskId: 'task', capsuleHash: notice.capsuleHash }));
    assert.equal(store.blockReason('native-source'), undefined);
    store.record({ ...notice, capsuleHash: 'b'.repeat(64), acceptedAt: 2 }, 'native-source');
    assert.ok(store.blockReason('native-source'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
