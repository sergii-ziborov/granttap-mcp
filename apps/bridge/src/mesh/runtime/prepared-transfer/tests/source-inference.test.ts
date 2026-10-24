import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { MeshHandoffPrepare, SessionInfo } from '../../../../../../../packages/protocol/schema';
import { MeshStore } from '../../../store';
import { inspectRepository, linkSessionsToProjects } from '../../../catalog';
import { resolveHandoffSource } from '../source-binding';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-source-inference-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MeshStore(join(root, 'mesh.json'), () => 1);
  store.upsertProject({ projectId: 'project', name: 'Project',
    canonicalRepositoryId: `local:${root}`, createdAt: 1 });
  store.upsertTask({ taskId: 'task', projectId: 'project', title: 'Task', goal: 'Continue Task',
    state: 'planned', ownerSessionId: 'source', createdAt: 1, updatedAt: 1 });
  const repository = (name: string, endpointId = 'mac') => {
    const path = join(root, name); mkdirSync(path);
    execFileSync('git', ['init', '-q', path]);
    writeFileSync(join(path, 'README.md'), 'Committed fixture\n');
    execFileSync('git', ['-C', path, 'add', '.']);
    execFileSync('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
      'commit', '-qm', 'base']);
    const facts = inspectRepository(path);
    store.upsertBinding({ bindingId: name, projectId: 'project', endpointId,
      repositoryId: facts.canonicalRepositoryId, displayName: name, localPathHint: facts.root,
      revision: facts.revision, available: true });
    return facts;
  };
  const session: SessionInfo = { sessionId: 'source', taskId: 'task', projectId: 'project',
    agent: 'claude', title: 'Task', cwd: root, state: 'idle',
    startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 };
  const request: MeshHandoffPrepare = { type: 'mesh.handoff.prepare', sessionId: 'source',
    taskId: 'task', projectId: 'project', targetProvider: 'codex', targetComputer: 'mac', createdAt: 1 };
  return { root, store, repository, session, request };
}

test('the owning execution supplies its admitted repository without another phone choice', t => {
  const f = fixture(t); f.repository('other'); const expected = f.repository('current');
  f.store.linkExecution({ taskId: 'task', sessionId: 'source', provider: 'claude',
    computerId: 'mac', workspace: f.root, repositoryId: expected.canonicalRepositoryId,
    worktree: expected.root, startedAt: 1 });
  const resolved = resolveHandoffSource(f.store, f.session, f.request, 'mac');
  assert.equal(resolved.worktree, expected.root);
  assert.equal(resolved.branch, expected.branch);
  assert.equal(f.session.cwd, f.root, 'The native source chat keeps its original working folder');
});

test('a sole local Project checkout is automatic while another computer is excluded', t => {
  const f = fixture(t); const expected = f.repository('current'); f.repository('foreign', 'another-mac');
  assert.equal(resolveHandoffSource(f.store, f.session, f.request, 'mac').worktree, expected.root);
});

test('ambiguous Project checkouts require a choice rather than choosing the first directory', t => {
  const f = fixture(t); f.repository('one'); f.repository('two');
  assert.throws(() => resolveHandoffSource(f.store, f.session, f.request, 'mac'), /choose|ambiguous|multiple/i);
});

test('catalog refresh preserves a Task checkout when its native chat reports only a parent folder', t => {
  const f = fixture(t); f.repository('other'); const expected = f.repository('current');
  f.store.linkExecution({ taskId: 'task', sessionId: 'source', provider: 'claude',
    computerId: 'mac', workspace: f.root, repositoryId: expected.canonicalRepositoryId,
    worktree: expected.root, startedAt: 1 });
  const [refreshed] = linkSessionsToProjects(f.store, [f.session], 'mac', inspectRepository, []);
  assert.equal(refreshed!.taskId, 'task');
  assert.equal(refreshed!.cwd, f.root);
  assert.equal(refreshed!.worktree, expected.root);
  assert.equal(resolveHandoffSource(f.store, refreshed!, f.request, 'mac').worktree, expected.root);
  assert.equal(f.store.snapshot('project')!.executions[0]!.repositoryId, expected.canonicalRepositoryId);
});

test('an unavailable known repository never falls back to another sole checkout', t => {
  const f = fixture(t); f.repository('other');
  f.store.linkExecution({ taskId: 'task', sessionId: 'source', provider: 'claude', computerId: 'mac',
    workspace: f.root, repositoryId: 'known-repository', startedAt: 1 });
  assert.throws(() => resolveHandoffSource(f.store, f.session, f.request, 'mac'), /unavailable/i);
});

test('an owned current claim and then the Project identity disambiguate source bindings', t => {
  const f = fixture(t); f.repository('other'); const expected = f.repository('current');
  f.store.upsertProject({ ...f.store.project('project')!, canonicalRepositoryId: expected.canonicalRepositoryId });
  assert.equal(resolveHandoffSource(f.store, f.session, f.request, 'mac').worktree, expected.root);
  const claimed = f.repository('claimed');
  f.store.claim({ claimId: 'claim', projectId: 'project', taskId: 'task', ownerSessionId: 'source',
    resource: claimed.root, mode: 'claim', repositoryId: claimed.canonicalRepositoryId,
    worktree: claimed.root, endpointId: 'mac', expiresAt: Date.now() + 60_000, createdAt: 1 });
  assert.equal(resolveHandoffSource(f.store, f.session, f.request, 'mac').worktree, claimed.root);
});
