import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { MeshStore } from '../../mesh/store';
import { createMeshRuntime, type MeshRuntimeDependencies } from '../../mesh/runtime';
import { PreparedTaskTransfers } from '../../task-transfer';
import { prepareNetworkTransfer } from '../runtime/preparation';
import { networkFixture } from './fixture';

test('a peer prepares one real Mesh execution and durable forwarded message without invoking an agent at preparation', async () => {
  const f = networkFixture();
  try {
    const store = new MeshStore(join(f.root, 'mesh.json'));
    store.upsertProject({ projectId: 'project', name: 'Project', canonicalRepositoryId: 'repo', createdAt: f.now });
    store.upsertBinding({ bindingId: 'binding', projectId: 'project', repositoryId: 'repo', endpointId: 'target',
      displayName: 'Repo', localPathHint: '/fixture/local', available: true });
    const transfers = new PreparedTaskTransfers(join(f.root, 'transfers'));
    let starts = 0, worktrees = 0;
    const forwarded: unknown[] = [];
    const runtime = (send: MeshRuntimeDependencies['send']) => createMeshRuntime({
      store: () => store, transfers: () => transfers, sessions: () => [], computer: () => 'target',
      now: () => f.now, eventId: () => 'peer-result-event', providerEnabled: () => true,
      hasCommit: () => true, fetch: () => false, push: () => ({ ok: true as const, remote: 'origin' }),
      worktree: () => { worktrees++; return { path: '/fixture/worktree', branch: 'granttap/fixture' }; },
      start: async () => { starts++; return { ok: true as const, text: 'Must not start', sessionId: 'wrong' }; },
      deliver: async () => ({ ok: true as const, text: 'Must not send' }), send,
    });
    const job = { ...f.job, createdAt: f.now - 8 * 86_400_000, notBefore: f.now - 8 * 86_400_000, operation: { ...f.job.operation, forward: { text: 'Continue the synthetic task', effort: 'high' as const } } };
    const options = { store, transfers, endpointId: 'target', runtime,
      queue: async (scope: unknown, message: unknown, notBefore: number, createdAt: number) => {
        assert.equal(createdAt, f.now, 'An old offline parent gives its new child a fresh durable admission time.');
        assert.equal(notBefore, f.now);
        forwarded.push({ scope, message, notBefore, createdAt });
      } };
    const first = await prepareNetworkTransfer(job, options);
    const second = await prepareNetworkTransfer(job, options);
    assert.equal(first.event.eventType, 'HANDOFF_ACCEPTED');
    assert.equal(second.event.payload.receipt?.targetSessionId, first.event.payload.receipt?.targetSessionId);
    assert.equal(starts, 0); assert.equal(worktrees, 1);
    assert.deepEqual(forwarded[0], forwarded[1], 'Repeated preparation uses the same durable child message identity.');
    assert.equal(transfers.catalog([])[0]?.title, 'Task');
    assert.equal(transfers.catalog([])[0]?.taskId, 'task');
  } finally { f.cleanup(); }
});

test('another Project or another current Task owner cannot be replaced by a peer transfer', async () => {
  const f = networkFixture();
  try {
    const store = new MeshStore(join(f.root, 'mesh.json'));
    const transfers = new PreparedTaskTransfers(join(f.root, 'transfers'));
    const options = { store, transfers, endpointId: 'target' };
    assert.equal((await prepareNetworkTransfer(f.job, options)).event.eventType, 'HANDOFF_REJECTED');
    store.upsertProject({ projectId: 'project', name: 'Project', canonicalRepositoryId: 'repo', createdAt: f.now });
    store.upsertBinding({ bindingId: 'binding', projectId: 'project', repositoryId: 'repo', endpointId: 'target',
      displayName: 'Repo', localPathHint: '/fixture/local', available: true });
    store.upsertTask({ ...f.job.operation.task, ownerSessionId: 'another-owner' });
    assert.equal((await prepareNetworkTransfer(f.job, options)).event.eventType, 'HANDOFF_REJECTED');
    assert.equal(store.task('task')?.ownerSessionId, 'another-owner');
    assert.deepEqual(transfers.catalog([]), []);
  } finally { f.cleanup(); }
});
