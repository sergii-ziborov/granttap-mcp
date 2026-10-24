import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { MeshStore } from '../../index';
import { handoffReceipt } from '../../../handoff';
import { PreparedTaskTransfers } from '../../../../task-transfer';
import { networkFixture } from '../../../../task-network/tests/fixture';

function fixture() {
  const f = networkFixture(), path = join(f.root, 'mesh.json');
  const store = new MeshStore(path, () => f.now + 100);
  store.upsertProject({ projectId: 'project', name: 'Fixture', repositoryRoot: '/fixture',
    canonicalRepositoryId: 'repo', createdAt: f.now });
  store.upsertTask(f.job.operation.task);
  store.linkExecution(f.job.operation.sourceExecution);
  const request = f.job.operation.event;
  store.acceptEvent(request);
  const transfers = new PreparedTaskTransfers(join(f.root, 'transfers'));
  const row = transfers.prepare({ eventId: request.eventId, projectId: 'project', title: 'Task',
    sourceSessionId: request.sourceSessionId, capsule: request.payload.capsule!,
    workspace: f.root, branch: 'fixture', context: request.payload.transferContext!, acceptedAt: f.now + 1 });
  store.linkExecution({ taskId: 'task', sessionId: row.sessionId, provider: 'grok', computerId: 'target',
    workspace: f.root, startedAt: row.acceptedAt });
  const receipt = { ...handoffReceipt(row.capsule, row.sourceSessionId, row.sessionId, row.acceptedAt + 1), prepared: true };
  store.acceptEvent({ ...request, eventId: 'accepted', sourceSessionId: row.sessionId,
    targetSessionId: row.sourceSessionId, eventType: 'HANDOFF_ACCEPTED', payload: { receipt } });
  // Reproduce the durable state left by the old native-only catalog sweep.
  const damaged = JSON.parse(readFileSync(path, 'utf8'));
  damaged.tasks[0].ownerSessionId = row.sourceSessionId;
  damaged.executions.find((item: { sessionId: string }) => item.sessionId === row.sessionId).endedAt = f.now + 10;
  writeFileSync(path, JSON.stringify(damaged));
  return { ...f, path, row, transfers, store: new MeshStore(path, () => f.now + 100) };
}

test('a retained accepted transfer repairs the owner and destination without starting a provider', () => {
  const f = fixture();
  try {
    f.transfers.reconcileCatalogOwnership(f.store, 'target');
    const snapshot = new MeshStore(f.path).snapshot('project')!;
    assert.equal(snapshot.tasks[0]!.ownerSessionId, f.row.sessionId);
    const destination = snapshot.executions.find(item => item.sessionId === f.row.sessionId)!;
    assert.equal(destination.endedAt, undefined);
    assert.equal(destination.preparedVerifiedAt, f.now + 100);
    assert.equal(destination.continuedAt, undefined, 'No consent to resume the source was invented.');
    assert.ok(snapshot.executions.find(item => item.sessionId === f.row.sourceSessionId)?.endedAt);
    const revision = snapshot.tasks[0]!.revision;
    f.transfers.reconcileCatalogOwnership(f.store, 'target');
    assert.equal(f.store.task('task')?.revision, revision, 'Recovery is idempotent.');
  } finally { f.cleanup(); }
});

for (const invalid of ['other-computer', 'changed-context', 'missing-receipt', 'completed', 'newer-transfer']) {
  test(`prepared recovery does not override ${invalid}`, () => {
    const f = fixture();
    try {
      const saved = JSON.parse(readFileSync(f.path, 'utf8'));
      if (invalid === 'changed-context') writeFileSync(f.transfers.contextPath(f.row.sessionId)!, 'changed');
      if (invalid === 'missing-receipt') saved.events = saved.events.filter((e: { eventId: string }) => e.eventId !== 'accepted');
      if (invalid === 'completed') saved.tasks[0].state = 'completed';
      if (invalid === 'newer-transfer') saved.events.push({ ...f.job.operation.event,
        eventId: 'newer', createdAt: f.now + 50, payload: { capsule: f.row.capsule } });
      writeFileSync(f.path, JSON.stringify(saved));
      f.transfers.reconcileCatalogOwnership(f.store, invalid === 'other-computer' ? 'elsewhere' : 'target');
      assert.equal(f.store.task('task')?.ownerSessionId, f.row.sourceSessionId);
      assert.ok(f.store.snapshot('project')?.executions.find(item => item.sessionId === f.row.sessionId)?.endedAt);
    } finally { f.cleanup(); }
  });
}
