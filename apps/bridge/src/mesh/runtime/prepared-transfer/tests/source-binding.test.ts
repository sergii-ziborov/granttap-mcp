import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MeshEvent, MeshHandoffPrepare, SessionInfo } from '../../../../../../../packages/protocol/schema';
import { MeshStore } from '../../../store';
import { inspectRepository } from '../../../catalog';
import { createMeshRuntime } from '../..';
import { PreparedTaskTransfers, transferDigest } from '../../../../task-transfer';
import { createHandoffWorktree } from '../../worktree';
import { handleTaskTransferCommand } from '../../../../task-transfer/runtime/commands';

test('a chat launched in a parent folder transfers only through an explicitly selected owned Git binding', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-handoff-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repository'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), 'Committed work\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base']);
  const store = new MeshStore(join(root, 'mesh.json'), () => Date.now());
  const sessions: SessionInfo[] = [{ sessionId: 'source', agent: 'claude', cwd: root, state: 'idle',
    title: 'Existing Task', startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 }];
  const sent: MeshEvent[] = [], captures: string[] = [];
  const transfers = new PreparedTaskTransfers(join(root, 'prepared'));
  let starts = 0;
  const runtime = createMeshRuntime({ store: () => store, sessions: () => sessions, computer: () => 'mac',
    now: Date.now, eventId: () => `event-${sent.length}`, providerEnabled: () => true,
    transfers: () => transfers, send: async (_, event) => { sent.push(event as MeshEvent); },
    captureTransferContext: async (source, facts) => {
      captures.push(source.worktree ?? source.cwd!);
      const context = JSON.stringify({ version: 1, facts, entries: [{ id: 'user', role: 'user', text: 'Synthetic work', at: 1 }] });
      return { context, hash: transferDigest(context) };
    },
    start: async () => { starts++; return { ok: true, text: 'Unexpected', sessionId: 'unexpected' }; },
    deliver: async () => ({ ok: true, text: 'Unused' }), hasCommit: () => true,
    fetch: () => false, push: () => ({ ok: true, remote: 'origin' }),
    worktree: (repository, taskId, provider, baseSha, operationId) => createHandoffWorktree({
      repository, taskId, provider, baseSha, operationId, worktreeRoot: join(root, 'worktrees') }),
  });
  const source = runtime.catalog(sessions)[0]!;
  const facts = inspectRepository(repo);
  store.upsertBinding({ bindingId: 'chosen', projectId: source.projectId!, endpointId: 'mac',
    repositoryId: facts.canonicalRepositoryId, displayName: 'Repository', localPathHint: repo,
    revision: facts.revision, available: true });
  const request = { type: 'mesh.handoff.prepare', sessionId: source.sessionId, projectId: source.projectId!,
    taskId: source.taskId!, targetProvider: 'codex', targetComputer: 'mac', prepareOnly: true,
    sourceBindingId: 'chosen', createdAt: Date.now() } as unknown as MeshHandoffPrepare;
  let published = 0;
  assert.equal(await handleTaskTransferCommand({} as any, { ...request, sourceBindingId: 'missing' },
    () => { published++; }, runtime.prepare), false);
  assert.equal(published, 1, 'A rejection also refreshes the retained Project snapshot');
  assert.equal(store.eventsForProject(source.projectId!).at(-1)?.eventType, 'TASK_BLOCKED');
  assert.equal(captures.length, 0, 'An unadmitted binding cannot read or carry conversation context');
  store.upsertBinding({ bindingId: 'foreign', projectId: source.projectId!, endpointId: 'another-mac',
    repositoryId: facts.canonicalRepositoryId, displayName: 'Foreign', localPathHint: repo,
    revision: facts.revision, available: true });
  assert.equal(await runtime.prepare({} as any, { ...request, sourceBindingId: 'foreign' }), false);
  assert.equal(captures.length, 0);
  assert.equal(await runtime.prepare({} as any, request), true);
  const accepted = sent.find(event => event.eventType === 'HANDOFF_ACCEPTED')!;
  assert.ok(accepted, JSON.stringify(sent.map(event => ({ type: event.eventType, reason: event.payload.reason }))));
  const prepared = transfers.catalog([])[0]!;
  assert.equal(prepared.taskId, source.taskId);
  assert.equal(prepared.projectId, source.projectId);
  assert.equal(prepared.title, 'Existing Task');
  assert.deepEqual(captures, [facts.root]);
  assert.equal(execFileSync('git', ['-C', prepared.cwd!, 'show', 'HEAD:README.md'], { encoding: 'utf8' }), 'Committed work\n');
  assert.equal(starts, 0, 'Preparing does not invoke a coding provider');
  assert.equal(sessions[0]!.cwd, root, 'The original native chat folder is not rewritten');
});
