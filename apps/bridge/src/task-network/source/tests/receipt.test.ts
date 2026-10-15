import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { MeshStore } from '../../../mesh/store';
import { handoffReceipt } from '../../../mesh/handoff';
import { networkFixture } from '../../tests/fixture';

test('an offline source restores a pruned request and the actual remote execution before applying its saved receipt', () => {
  const f = networkFixture();
  try {
    const store = new MeshStore(join(f.root, 'mesh.json'), () => f.now + 2 * 86_400_000);
    store.upsertProject({ projectId: 'project', name: 'Project', canonicalRepositoryId: 'repo', createdAt: f.now });
    store.upsertTask(f.job.operation.task);
    store.linkExecution(f.job.operation.sourceExecution);
    const request = { ...f.job.operation.event, expiresAt: f.now + 1_000,
      payload: { capsule: f.job.operation.event.payload.capsule } };
    const receipt = handoffReceipt(request.payload.capsule!, 'source-chat', 'target-chat', f.now + 1);
    receipt.prepared = true;
    const event = { ...request, eventId: 'confirmed', sourceSessionId: 'target-chat', targetSessionId: 'source-chat',
      eventType: 'HANDOFF_ACCEPTED' as const, payload: { receipt } };
    const destination = { taskId: 'task', sessionId: 'target-chat', computerId: 'target', provider: 'grok' as const,
      workspace: '/actual/target/worktree', startedAt: f.now + 1, state: 'idle' as const };
    assert.equal(store.acceptRecoveredHandoff(request, event, destination), true);
    const restarted = new MeshStore(join(f.root, 'mesh.json'));
    assert.equal(restarted.task('task')?.ownerSessionId, 'target-chat');
    assert.equal(restarted.snapshot('project')?.executions.find(row => row.sessionId === 'target-chat')?.workspace,
      '/actual/target/worktree');
    assert.equal(store.acceptRecoveredHandoff(request, event, destination), true, 'Receipt application is idempotent.');
    const newer = { ...request, eventId: 'newer-request', createdAt: f.now + 5,
      expiresAt: undefined, payload: { capsule: { ...request.payload.capsule!, targetComputer: 'third-computer' } } };
    store.acceptEvent(newer);
    assert.equal(store.acceptRecoveredHandoff(request, { ...event, eventId: 'late-replay' }, destination), false);
    assert.equal(store.task('task')?.ownerSessionId, 'target-chat');
    assert.equal(store.historyEventsForProject('project').at(-1)?.eventId, 'newer-request');
  } finally { f.cleanup(); }
});
