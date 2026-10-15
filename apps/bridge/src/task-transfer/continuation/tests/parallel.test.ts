import assert from 'node:assert/strict';
import test from 'node:test';
import { preferExecution } from '../../../mesh/admin/convergence';
import { taskAfterLocalReading } from '../../../mesh/tasks/state';
import type { ExecutionSessionLink, MeshTask } from '../../../../../../packages/protocol/schema';

test('a confirmed source continuation reopens only its execution and can work beside the transferred owner', () => {
  const source: ExecutionSessionLink = { taskId: 'task', sessionId: 'source', provider: 'codex', computerId: 'computer',
    workspace: '/fixture/source', startedAt: 1, endedAt: 20, updatedAt: 20 };
  const continued = preferExecution(source, { ...source, endedAt: undefined, continuedAt: 30, updatedAt: 31,
    state: 'working' } as ExecutionSessionLink);
  assert.equal(continued.endedAt, undefined);
  const target: ExecutionSessionLink = { taskId: 'task', sessionId: 'target', provider: 'grok', computerId: 'computer',
    workspace: '/fixture/target', startedAt: 20, state: 'working' } as ExecutionSessionLink;
  const task: MeshTask = { taskId: 'task', projectId: 'project', title: 'Original', goal: 'Synthetic task',
    state: 'planned', ownerSessionId: 'target', createdAt: 1, updatedAt: 20 };
  const reading = taskAfterLocalReading(task, { ...task, state: 'working', ownerSessionId: 'source', updatedAt: 31 },
    [continued, target]);
  assert.equal(reading?.state, 'working');
  assert.equal(reading?.ownerSessionId, 'target');
  assert.equal(target.endedAt, undefined);
  assert.equal(preferExecution(source, { ...source, endedAt: undefined, updatedAt: 100 }).endedAt, 20,
    'An ordinary stale native reading cannot undo a transfer.');
});

test('one completed branch does not complete the Task while its other branch is working', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { MeshStore } = await import('../../../mesh/store');
  const root = mkdtempSync(join(tmpdir(), 'granttap-parallel-'));
  try {
    let store = new MeshStore(join(root, 'mesh.json'), () => 100);
    store.upsertProject({ projectId: 'project', name: 'Project', canonicalRepositoryId: 'repo', createdAt: 1 });
    store.upsertTask({ taskId: 'task', projectId: 'project', title: 'Original', goal: 'Synthetic task',
      state: 'working', ownerSessionId: 'target', createdAt: 1, updatedAt: 1 });
    for (const id of ['source', 'target']) store.linkExecution({ taskId: 'task', sessionId: id,
      provider: id === 'source' ? 'codex' : 'grok', computerId: 'computer', workspace: `/fixture/${id}`,
      startedAt: 1, continuedAt: id === 'source' ? 30 : undefined, state: 'working' });
    const event = (id: string, at: number) => ({ type: 'mesh.event' as const, sessionId: 'task', eventId: `finished-${id}`,
      projectId: 'project', taskId: 'task', sourceSessionId: id, eventType: 'TASK_COMPLETED' as const,
      createdAt: at, payload: { summary: "Synthetic completion" } });
    assert.equal(store.acceptEvent(event('source', 40)), true);
    assert.equal(store.task('task')?.state, 'working');
    store = new MeshStore(join(root, 'mesh.json'), () => 100);
    assert.equal(store.acceptEvent(event('target', 50)), true);
    assert.equal(store.task('task')?.state, 'completed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
