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
