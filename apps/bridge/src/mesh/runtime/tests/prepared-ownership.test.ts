import assert from 'node:assert/strict';
import test from 'node:test';
import { closeVanished } from '../execution-sweep';
import { mayOwnTask, preferExecution } from '../../admin/convergence';
import type { ExecutionSessionLink, MeshTask } from '../../../../../../packages/protocol/schema';

const target = `transfer-${'a'.repeat(48)}`;
const execution = (sessionId: string): ExecutionSessionLink => ({
  sessionId, taskId: 'task', provider: 'grok', computerId: 'mac', workspace: '/repo', startedAt: 1,
});
const task: MeshTask = { taskId: 'task', projectId: 'project', title: 'Task', goal: 'Continue',
  state: 'planned', ownerSessionId: target, createdAt: 1, updatedAt: 1 };

test('native catalog absence cannot end a prepared transfer execution', () => {
  const rows = [execution(target), execution('native-gone')];
  assert.equal(closeVanished(rows, { computerId: 'mac', liveSessionIds: new Set(),
    scannedProviders: new Set(['grok']), endedAt: 20 }), 1);
  assert.equal(rows[0]!.endedAt, undefined);
  assert.equal(rows[1]!.endedAt, 20);
});

test('a previously ended source cannot reclaim a Task even after its destination ended', () => {
  assert.equal(mayOwnTask(task, 'old-source', [
    { ...execution('old-source'), endedAt: 10 }, { ...execution(target), endedAt: 20 },
  ]), false);
});

test('durably verified prepared availability repairs a false closure but not a newer handoff', () => {
  const live = { ...execution(target), preparedVerifiedAt: 30 };
  const ended = { ...execution(target), endedAt: 20 };
  assert.equal(preferExecution(ended, live).endedAt, undefined);
  assert.equal(preferExecution(live, ended).endedAt, undefined);
  assert.equal(preferExecution(live, { ...ended, endedAt: 40 }).endedAt, 40);
  const refreshed = preferExecution(live, { ...execution(target), updatedAt: 40 });
  assert.equal(refreshed.preparedVerifiedAt, 30);
  assert.equal(preferExecution(refreshed, ended).endedAt, undefined);
  assert.equal(preferExecution({ ...ended, sessionId: 'native' },
    { ...live, sessionId: 'native' }).endedAt, 20);
});
