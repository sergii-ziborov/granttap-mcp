import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptHistory } from '../../index';
import { codexActivitySourcesBySession, codexLogPathBySession } from '../../../sessions/scan/codex/shared';
import type { ChildThreadInfo, SessionInfo } from '../../../../../../packages/protocol/schema';

const at = (i: number) => new Date(1_800_000_000_000 + i * 1000).toISOString();
const row = (i: number, payload: unknown, type = 'event_msg') => JSON.stringify({ timestamp: at(i), type, payload });
const fileChange = (i: number, id: string, changes: Record<string, unknown>) =>
  row(i, { type: 'item_completed', item: { type: 'FileChange', id, status: 'completed', changes } });

test('a Codex reply lists the files its agents changed during that turn, each marked with its agent', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-codex-agent-files-'));
  const chat = join(root, 'chat'), worktree = join(root, 'review-worktree');
  mkdirSync(join(chat, '.git'), { recursive: true });
  mkdirSync(join(worktree, '.git'), { recursive: true });
  const session: SessionInfo = { sessionId: 'codex-agent-files', agent: 'codex', state: 'idle', cwd: chat,
    startedAt: 1, lastActivityAt: 100, tokensSession: 0, tokensLastTurn: 0 };
  const parent = join(root, 'parent.jsonl'), childPath = join(root, 'child.jsonl'), quiet = join(root, 'quiet.jsonl');
  t.after(() => {
    codexLogPathBySession.delete(session.sessionId); codexActivitySourcesBySession.delete(session.sessionId);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(parent, [
    row(0, { type: 'task_started', turn_id: 'turn' }),
    row(1, { type: 'user_message', message: 'Review and fix' }),
    row(2, { type: 'item_completed', turn_id: 'turn', item: { type: 'FileChange', id: 'own', status: 'completed',
      changes: { [join(chat, 'own.ts')]: { type: 'add', content: 'own\n' } } } }),
    row(50, { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] }, 'response_item'),
  ].join('\n') + '\n');
  writeFileSync(childPath, [
    JSON.stringify({ type: 'session_meta', timestamp: at(5), payload: { id: 'child-1', cwd: worktree,
      source: { subagent: { thread_spawn: { parent_thread_id: session.sessionId, depth: 1, agent_nickname: 'Reviewer' } } } } }),
    fileChange(10, 'c1', { [join(worktree, 'fix.ts')]: { type: 'update', unified_diff: '@@\n-a\n+b' } }),
    fileChange(60, 'c2', { [join(worktree, 'later.ts')]: { type: 'add', content: 'later\n' } }),
  ].join('\n') + '\n');
  writeFileSync(quiet, [JSON.stringify({ type: 'session_meta', timestamp: at(6), payload: { id: 'child-2' } }),
    fileChange(20, 'q1', { [join(worktree, 'quiet.ts')]: { type: 'add', content: 'q\n' } })].join('\n') + '\n');
  const child = (threadId: string, extra: Partial<ChildThreadInfo>): ChildThreadInfo => ({ threadId,
    parentThreadId: session.sessionId, depth: 1, state: 'idle', startedAt: 5, lastActivityAt: 60,
    tokensSession: 0, tokensLastTurn: 0, ...extra });
  codexLogPathBySession.set(session.sessionId, parent);
  codexActivitySourcesBySession.set(session.sessionId, [{ path: parent },
    { path: childPath, child: child('child-1', { agentName: 'Reviewer' }) },
    { path: quiet, child: child('child-2', {}) },
    { path: join(root, 'removed.jsonl'), child: child('child-3', {}) }]);

  for (let read = 0; read < 2; read++) {
    const final = readTranscriptHistory(session)?.entries.find(entry => entry.kind === 'final');
    assert.deepEqual(final?.fileChanges?.map(file => [file.path, file.linesAdded, file.agentThreadId, file.agentTitle, file.folder]), [
      [join(chat, 'own.ts'), 1, undefined, undefined, chat],
      [join(worktree, 'fix.ts'), 1, 'child-1', 'Reviewer', worktree],
      [join(worktree, 'quiet.ts'), 1, 'child-2', undefined, worktree],
    ]);
    assert.equal(final?.fileChangesComplete, true);
    assert.match(final!.fileChanges![1]!.diff, /-a\n\+b/);
  }
});
