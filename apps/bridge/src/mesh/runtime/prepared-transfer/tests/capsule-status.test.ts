import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MeshHandoffPrepare, SessionInfo } from '../../../../../../../packages/protocol/schema';
import { MeshStore } from '../../../store';
import { inspectRepository } from '../../../catalog';
import { buildTaskCapsule } from '../../../admin/capsule';

test('a long native summary does not turn a valid repository transfer into a missing-Git error', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-capsule-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'README.md'), 'Committed fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    'commit', '-qm', 'base']);
  const facts = inspectRepository(root);
  const store = new MeshStore(join(root, 'mesh.json'), () => 1);
  store.upsertProject({ projectId: 'project', name: 'Project',
    canonicalRepositoryId: facts.canonicalRepositoryId, createdAt: 1 });
  store.upsertTask({ taskId: 'task', projectId: 'project', title: 'Task', goal: 'Continue Task',
    state: 'planned', ownerSessionId: 'source', createdAt: 1, updatedAt: 1 });
  store.upsertBinding({ bindingId: 'repository', projectId: 'project', endpointId: 'mac',
    repositoryId: facts.canonicalRepositoryId, displayName: 'Repository',
    localPathHint: facts.root, revision: facts.revision, available: true });
  const session: SessionInfo = { sessionId: 'source', taskId: 'task', projectId: 'project',
    agent: 'claude', title: 'Task', cwd: root, worktree: facts.root, state: 'idle',
    startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0,
    summary: 'Native summary. '.repeat(200) };
  const request: MeshHandoffPrepare = { type: 'mesh.handoff.prepare', sessionId: 'source',
    taskId: 'task', projectId: 'project', targetProvider: 'codex', targetComputer: 'mac', createdAt: 1 };
  const capsule = buildTaskCapsule(store, session, request, 'mac');
  assert.ok(capsule, 'Git, Task, binding and commit are all available');
  assert.equal(capsule.baseSha, facts.revision);
  assert.equal(capsule.repository, facts.canonicalRepositoryId);
  assert.equal(capsule.currentStatus, session.summary!.trim().slice(0, 1_000));
  assert.equal(session.summary!.length, 3_200, 'Full native history metadata is not mutated');
  assert.equal(buildTaskCapsule(store, { ...session, summary: '  ' }, request, 'mac')?.currentStatus, 'Task');
});
