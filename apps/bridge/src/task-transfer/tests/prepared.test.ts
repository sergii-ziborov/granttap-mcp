import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PreparedTaskTransfers } from '../index';

const capsule = { taskId: 'task-fixture', goal: 'Synthetic task', currentStatus: 'Ready',
  sourceProvider: 'codex' as const, sourceComputer: 'computer-source',
  targetProvider: 'grok' as const, targetComputer: 'computer-target',
  repository: 'repo-fixture', baseSha: 'a'.repeat(40), workingTree: 'clean' as const,
  filesChanged: [], dependencies: [], resourceClaims: [], remainingWork: ['Verify'],
  importantDecisions: ['Keep public API'], createdAt: 1 };

test('preparing a transfer persists its task and title without running a provider; first message starts it once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-transfer-'));
  try {
    const transfers = new PreparedTaskTransfers(root);
    const input = { eventId: 'transfer-fixture', projectId: 'project-fixture', title: 'Original title',
      sourceSessionId: 'source-chat', capsule, workspace: '/fixture/worktree', branch: 'granttap/fixture',
      context: 'USER: Synthetic request\nASSISTANT: Visible answer', acceptedAt: 100 };
    const prepared = transfers.prepare(input);
    assert.equal(transfers.prepare(input).sessionId, prepared.sessionId);
    assert.equal(transfers.catalog([])[0]?.title, 'Original title');
    assert.equal(transfers.catalog([])[0]?.state, 'idle');
    let creates = 0, resumes = 0;
    const provider = {
      start: async (request: any) => {
        creates++;
        assert.ok(request.text.includes(input.context));
        assert.ok(request.text.includes('Continue now'));
        assert.equal(request.model, 'fixture-model');
        assert.equal(request.effort, 'high');
        return { ok: true as const, sessionId: 'native-chat', text: 'First answer' };
      },
      resume: async (session: any) => { resumes++; assert.equal(session.sessionId, 'native-chat');
        return { ok: true as const, text: 'Next answer' }; },
    };
    assert.equal(creates, 0);
    const first = await transfers.deliver(prepared.sessionId, 'Continue now', [],
      { model: 'fixture-model', effort: 'high' }, provider);
    assert.equal(first?.ok, true);
    const restarted = new PreparedTaskTransfers(root);
    const result = await restarted.deliver(prepared.sessionId, 'Next message', [], {}, provider);
    assert.equal(result?.ok, true);
    assert.equal(creates, 1); assert.equal(resumes, 1);
    const rows = restarted.catalog([{ ...restarted.catalog([])[0]!, sessionId: 'native-chat', state: 'working' }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sessionId, prepared.sessionId);
    assert.equal(rows[0]?.taskId, capsule.taskId);
    assert.equal(rows[0]?.state, 'working');
    assert.equal(rows[0]?.title, 'Original title');
    assert.equal(readFileSync(restarted.contextPath(prepared.sessionId)!, 'utf8'), input.context);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed or interrupted first launch never silently starts a second native execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-transfer-'));
  try {
    const transfers = new PreparedTaskTransfers(root);
    const row = transfers.prepare({ eventId: 'uncertain-fixture', projectId: 'project-fixture', title: 'Task',
      sourceSessionId: 'source', capsule, workspace: '/fixture', branch: 'granttap/fixture', context: 'Visible context', acceptedAt: 1 });
    let calls = 0;
    const provider = { start: async () => { calls++; throw new Error('Connection interrupted'); },
      resume: async () => ({ ok: true as const, text: 'Unused' }) };
    const result = await transfers.deliver(row.sessionId, 'Go', [], {}, provider);
    assert.equal(result?.ok, false);
    await new PreparedTaskTransfers(root).deliver(row.sessionId, 'Retry', [], {}, provider);
    assert.equal(calls, 1);
    assert.equal(transfers.catalog([])[0]?.state, 'waiting');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('confirmed first-turn identity is durable while the provider is still running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-live-transfer-'));
  let finish!: () => void;
  const complete = new Promise<void>(resolve => { finish = resolve; });
  try {
    const transfers = new PreparedTaskTransfers(root);
    const row = transfers.prepare({ eventId: 'live-fixture', projectId: 'project-fixture', title: 'Live task',
      sourceSessionId: 'source', capsule, workspace: '/fixture', branch: 'granttap/fixture',
      context: 'Visible context', acceptedAt: 1 });
    let starts = 0;
    const provider = { start: async (request: any) => {
      starts++; request.onNativeSession?.('confirmed-native-chat'); await complete;
      return { ok: true as const, sessionId: 'confirmed-native-chat', text: 'Done' };
    }, resume: async () => ({ ok: true as const, text: 'Unused' }) };
    const pending = transfers.deliver(row.sessionId, 'Work now', [], {}, provider);
    await new Promise<void>(resolve => setImmediate(resolve));
    const restored = new PreparedTaskTransfers(root);
    const alias = restored.catalog([])[0]!;
    assert.equal(restored.nativeSession(alias).sessionId, 'confirmed-native-chat');
    assert.equal(restored.catalog([{ ...alias, sessionId: 'confirmed-native-chat', state: 'working' }]).length, 1);
    assert.equal((await restored.deliver(row.sessionId, 'Repeat', [], {}, provider))?.ok, false);
    assert.equal(starts, 1, 'An unfinished first turn cannot start a second execution');
    finish(); await pending;
    assert.equal(new PreparedTaskTransfers(root).nativeSession(alias).sessionId, 'confirmed-native-chat');
  } finally { finish?.(); rmSync(root, { recursive: true, force: true }); }
});

test("after an interrupted first turn, the person's next message continues the session the agent did open", async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-transfer-'));
  try {
    const transfers = new PreparedTaskTransfers(root);
    const row = transfers.prepare({ eventId: 'opened-fixture', projectId: 'project-fixture', title: 'Task',
      sourceSessionId: 'source', capsule, workspace: '/fixture', branch: 'granttap/fixture', context: 'Visible context', acceptedAt: 1 });
    let starts = 0;
    const resumed: string[] = [];
    const provider = {
      start: async (request: any) => { starts++; request.onNativeSession('opened-native-chat'); throw new Error('Connection interrupted'); },
      resume: async (session: any, text: string) => { resumed.push(`${session.sessionId}:${text}`); return { ok: true as const, text: 'Continued' }; },
    };
    assert.equal((await transfers.deliver(row.sessionId, 'Go', [], {}, provider))?.ok, false);
    const next = await new PreparedTaskTransfers(root).deliver(row.sessionId, 'Are you there?', [], {}, provider);
    assert.equal(next?.ok, true, 'the chat is not a dead end');
    assert.equal(next?.sessionId, row.sessionId);
    assert.deepEqual(resumed, ['opened-native-chat:Are you there?'], 'the opened session is continued, not started twice');
    assert.equal(starts, 1);
    assert.equal(new PreparedTaskTransfers(root).catalog([])[0]?.state, 'idle', 'and the transfer is active again');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted first turn that opened no session starts again only on a message sent after ten quiet minutes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-transfer-'));
  try {
    const transfers = new PreparedTaskTransfers(root);
    const row = transfers.prepare({ eventId: 'unopened-fixture', projectId: 'project-fixture', title: 'Task',
      sourceSessionId: 'source', capsule, workspace: '/fixture', branch: 'granttap/fixture', context: 'Visible context', acceptedAt: 1 });
    let starts = 0, fail = true;
    const provider = {
      start: async () => { starts++; if (fail) throw new Error('Connection interrupted');
        return { ok: true as const, sessionId: 'second-native-chat', text: 'Started' }; },
      resume: async () => ({ ok: true as const, text: 'Unused' }),
    };
    const at = Date.now();
    await transfers.deliver(row.sessionId, 'Go', [], {}, provider, at);
    fail = false;
    const soon = await transfers.deliver(row.sessionId, 'Go', [], {}, provider, at + 9 * 60_000);
    assert.equal(soon?.ok, false, 'a transport retry of the same message is still refused');
    assert.match(soon && !soon.ok ? soon.error : '', /ten minutes/);
    assert.equal(starts, 1);
    const later = await new PreparedTaskTransfers(root).deliver(row.sessionId, 'Please start again', [], {}, provider, at + 11 * 60_000);
    assert.equal(later?.ok, true, 'a message the person sends later is a deliberate new attempt');
    assert.equal(starts, 2);
    assert.equal(new PreparedTaskTransfers(root).nativeSession(new PreparedTaskTransfers(root).catalog([])[0]!).sessionId, 'second-native-chat');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
