import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TaskCapsule, type MeshEvent, type MeshHandoffPrepare, type SessionInfo } from '../../../../../../../../packages/protocol/schema';
import { MeshStore } from '../../../../store';
import { createMeshRuntime } from '../../..';
import { PreparedTaskTransfers, transferDigest } from '../../../../../task-transfer';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-folder-transfer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MeshStore(join(root, 'mesh.json'), Date.now);
  const transfers = new PreparedTaskTransfers(join(root, 'prepared'));
  const sent: MeshEvent[] = [];
  let sequence = 0, starts = 0, gitOperations = 0;
  const sessions: SessionInfo[] = [{ sessionId: 'source', agent: 'grok', cwd: root,
    title: 'Non-Git work', state: 'idle', startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 }];
  const runtime = createMeshRuntime({ store: () => store, sessions: () => sessions, computer: () => 'mac',
    now: Date.now, eventId: () => `event-${sequence++}`, providerEnabled: () => true,
    transfers: () => transfers, send: async (_, event) => { sent.push(event as MeshEvent); },
    captureTransferContext: async (_, facts) => {
      const context = JSON.stringify({ version: 1, facts, entries: [{ id: 'user', role: 'user', text: 'Synthetic history', at: 1 }] });
      return { context, hash: transferDigest(context) };
    },
    start: async () => { starts++; return { ok: true, text: '', sessionId: 'unexpected' }; },
    deliver: async () => ({ ok: true, text: '' }),
    hasCommit: () => { gitOperations++; return false; }, fetch: () => { gitOperations++; return false; },
    push: () => { gitOperations++; return { ok: false, error: 'No Git' }; },
    worktree: () => { gitOperations++; return undefined; },
  });
  const source = runtime.catalog(sessions)[0]!;
  const request: MeshHandoffPrepare = { type: 'mesh.handoff.prepare', sessionId: source.sessionId,
    projectId: source.projectId!, taskId: source.taskId!, targetProvider: 'claude', targetComputer: 'mac',
    prepareOnly: true, createdAt: Date.now() };
  return { root, store, transfers, runtime, request, source, sent, counters: () => ({ starts, gitOperations }) };
}

test('a non-Git Task transfers locally with its full history and existing files, without starting or creating Git', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'notes.txt'), 'Uncommitted original bytes');
  assert.equal(await f.runtime.prepare({} as any, f.request), true);
  const row = f.transfers.catalog([])[0]!;
  assert.equal(row.cwd, f.root);
  assert.equal(row.worktree, undefined, 'A directory must not be advertised as a Git worktree');
  assert.equal(row.branch, undefined);
  assert.equal(row.taskId, f.source.taskId);
  assert.equal(row.title, 'Non-Git work');
  assert.deepEqual(f.counters(), { starts: 0, gitOperations: 0 });
  const accepted = f.sent.find(event => event.eventType === 'HANDOFF_ACCEPTED')!;
  assert.ok(accepted);
  const record = f.transfers.forEvent(f.sent.find(event => event.eventType === 'HANDOFF_REQUEST')!.eventId)!;
  assert.equal(record.capsule.workspaceMode, 'local_directory');
  assert.equal(record.capsule.baseSha, undefined, 'No fabricated commit');
  const reopened = new PreparedTaskTransfers(join(f.root, 'prepared'));
  let prompt = '';
  const result = await reopened.deliver(row.sessionId, 'Continue', [], {}, {
    start: async request => { prompt = request.text; assert.equal(request.cwd, f.root);
      request.onNativeSession('native-claude'); return { ok: true, text: 'Ready', sessionId: 'native-claude' }; },
    resume: async () => ({ ok: false, error: 'Unexpected resume' }),
  });
  assert.equal(result?.ok, true);
  assert.match(prompt, /same working folder/i);
  assert.doesNotMatch(prompt, /Repository revision: undefined|separate worktree/);
  assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'Uncommitted original bytes');
  assert.equal(existsSync(join(f.root, '.git')), false);
});

test('a folder transfer cannot imply copying files to another computer or a cloud runner', async t => {
  const f = fixture(t);
  for (const change of [{ targetComputer: 'other' }, { cloud: {} }, { checkpoint: true }, { push: true }]) {
    assert.equal(await f.runtime.prepare({} as any, { ...f.request, ...change }), false);
  }
  assert.equal(f.transfers.catalog([]).length, 0);
  assert.deepEqual(f.counters(), { starts: 0, gitOperations: 0 });
});

test('folder capsules cannot be replayed as Git or cross-computer transfers', () => {
  const folder = { taskId:'task',goal:'Continue',currentStatus:'Ready',sourceProvider:'grok',sourceComputer:'mac',
    targetProvider:'claude',targetComputer:'mac',repository:'local:/workspace',workspaceMode:'local_directory',
    filesChanged:[], dependencies:[], resourceClaims:[], remainingWork:[], importantDecisions:[], createdAt:1 };
  assert.equal(TaskCapsule.safeParse(folder).success, true);
  for (const change of [{targetComputer:'other'}, {baseSha:'a'.repeat(40)}, {branch:'fake'},
    {latestCommit:'a'.repeat(40)}, {workspaceMode:undefined}]) {
    assert.equal(TaskCapsule.safeParse({...folder,...change}).success, false);
  }
});
