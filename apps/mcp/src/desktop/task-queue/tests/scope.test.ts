import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { desktopTaskQueue } from '../index';

test('native queued work is confined to the exact local Mesh Task and execution', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-queue-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storePath = join(root, 'mesh.json');
  writeFileSync(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: 'mesh', name: 'Fixture', createdAt: 1 }],
    tasks: [{ taskId: 'task', projectId: 'mesh', title: 'Fixture', goal: 'Synthetic task',
      state: 'working', createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: 'task', sessionId: 'chat', provider: 'grok', computerId: 'local', workspace: root, startedAt: 1 }],
  }));
  const now = Date.now(), id = randomUUID(), calls: unknown[] = [];
  const receipt = { id, state: 'queued' as const, notBefore: now, expiresAt: now + 60_000 };
  const sender = { submit: async (...args: unknown[]) => { calls.push(args); return receipt; },
    status: async () => receipt, cancel: async () => ({ ...receipt, state: 'cancelled' as const }) };
  const options = { storePath, endpointId: 'local', sender, providerEnabled: () => true };
  const request = { action: 'put', project_id: 'mesh', task_id: 'task', session_id: 'chat', delivery_id: id,
    text: 'Synthetic queued task', model: 'grok-build', effort: 'high', not_before: now, created_at: now,
    delivery_mode: 'immediate' };
  assert.equal(await desktopTaskQueue({ ...request, project_id: 'other' }, options), undefined);
  assert.equal(await desktopTaskQueue(request, { ...options, endpointId: 'remote' }), undefined);
  assert.equal(await desktopTaskQueue({ ...request, session_id: 'other' }, options), undefined);
  const accepted = await desktopTaskQueue(request, options) as { accepted: boolean; job: unknown };
  assert.equal(accepted.accepted, true); assert.deepEqual(accepted.job, receipt);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as unknown[])[4], 'immediate');
  const [, operation] = calls[0] as [unknown, { agent: string; effort: string; model: string }];
  assert.equal(operation.agent, 'grok'); assert.equal(operation.effort, 'high'); assert.equal(operation.model, 'grok-build');
  const cancelled = await desktopTaskQueue({ ...request, action: 'cancel' }, options) as { job: { state: string } };
  assert.equal(cancelled.job.state, 'cancelled');
  const denied = await desktopTaskQueue(request, { ...options, providerEnabled: () => false }) as { accepted: boolean };
  assert.equal(denied.accepted, false); assert.equal(calls.length, 1);
});
