import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PreparedTaskTransfers, transferDigest } from '../index';
import { createMeshRuntime } from '../../mesh/runtime';
import { MeshStore } from '../../mesh/store';
import type { MeshEvent, TaskCapsule } from '../../../../../packages/protocol/schema';

test('a prepared transfer is accepted once without invoking any provider and keeps the source branch intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-handoff-'));
  try {
    const store = new MeshStore(join(root, 'mesh.json'), () => 2);
    store.upsertProject({ projectId: 'project', name: 'Project', canonicalRepositoryId: 'repo', createdAt: 1 });
    store.upsertTask({ taskId: 'task', projectId: 'project', title: 'Exact original title', goal: 'Synthetic work',
      state: 'working', ownerSessionId: 'source-chat', createdAt: 1, updatedAt: 1 });
    store.upsertBinding({ bindingId: 'binding', projectId: 'project', endpointId: 'target', repositoryId: 'repo',
      displayName: 'Project', localPathHint: '/fixture/repo', available: true });
    const transfers = new PreparedTaskTransfers(join(root, 'transfers'));
    const context = 'USER: Synthetic work\nASSISTANT: Visible progress';
    const capsule: TaskCapsule = { taskId: 'task', title: 'Exact original title', goal: 'Synthetic work', currentStatus: 'Ready',
      launch: 'on_message', contextHash: transferDigest(context), sourceProvider: 'codex', sourceComputer: 'source',
      targetProvider: 'grok', targetComputer: 'target', repository: 'repo', baseSha: 'a'.repeat(40),
      workingTree: 'clean', filesChanged: [], dependencies: [], resourceClaims: [], remainingWork: [], importantDecisions: [], createdAt: 1 };
    const request: MeshEvent = { type: 'mesh.event', sessionId: 'task', eventId: 'transfer-event',
      projectId: 'project', taskId: 'task', sourceSessionId: 'source-chat', eventType: 'HANDOFF_REQUEST',
      createdAt: 1, payload: { capsule, transferContext: context } };
    let starts = 0, worktrees = 0;
    const sent: MeshEvent[] = [];
    const runtime = createMeshRuntime({ store: () => store, sessions: () => [], computer: () => 'target',
      now: () => 2, eventId: () => `receipt-${sent.length}`, providerEnabled: () => true,
      transfers: () => transfers,
      start: async () => { starts++; return { ok: true as const, sessionId: 'wrong-native', text: 'Unexpected' }; },
      deliver: async () => ({ ok: true as const, text: 'Unused' }),
      hasCommit: () => true, fetch: () => false, push: () => ({ ok: true as const, remote: 'origin' }),
      worktree: () => { worktrees++; return { path: '/fixture/isolated', branch: 'granttap/isolated' }; },
      send: async (_, event) => { sent.push(event as MeshEvent); },
    });
    await runtime.handle({} as any, request);
    await runtime.handle({} as any, request);
    assert.equal(starts, 0); assert.equal(worktrees, 1);
    const prepared = transfers.catalog([])[0]!;
    assert.equal(prepared.title, 'Exact original title'); assert.equal(prepared.taskId, 'task');
    assert.equal(store.eventsForProject('project').find(event => event.eventType === 'HANDOFF_ACCEPTED')?.payload.receipt?.targetSessionId, prepared.sessionId);
    assert.equal(sent.at(-1)?.eventType, 'HANDOFF_ACCEPTED');
    assert.equal(sent.at(-1)?.payload.receipt?.targetSessionId, prepared.sessionId);
    assert.ok(!JSON.stringify(store.snapshot('project')).includes(context), 'Full context must not flood Mesh snapshots.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
