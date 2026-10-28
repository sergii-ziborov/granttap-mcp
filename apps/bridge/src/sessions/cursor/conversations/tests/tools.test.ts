import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { beginCursorTurn, cursorConversationHistory } from '../index';
import type { SessionInfo } from '../../../../../../../packages/protocol/schema';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-tool-history-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const session: SessionInfo = { sessionId: 'native-cursor', cwd: root, agent: 'cursor', state: 'idle',
    startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 };
  const turn = beginCursorTurn({ sessionId: session.sessionId, cwd: root, text: 'Synthetic user request' });
  const event = (value: object) => (turn as any).tool?.(value);
  return { turn, event, session, entries: () => cursorConversationHistory(session)!.entries };
}

test('Cursor tool events preserve commentary and a separate final answer without duplicate tools', t => {
  const f = fixture(t);
  f.turn.update('Inspecting the file.');
  f.event({ sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read fixture', kind: 'read' });
  f.event({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' });
  f.turn.update('CURSOR_FIXTURE_OK'); f.turn.finish();
  assert.deepEqual(f.entries().map(row => [row.kind, row.text]), [
    ['user', 'Synthetic user request'], ['message', 'Inspecting the file.'],
    ['tool', 'Read fixture'], ['final', 'CURSOR_FIXTURE_OK'],
  ]);
  assert.equal(f.entries().filter(row => row.kind === 'tool')[0]?.outcome, 'success');
});

test('only successful native Cursor diffs publish edits; late turns and failures cannot invent them', t => {
  const f = fixture(t);
  const content = [{ type: 'diff', path: 'fixture.txt', oldText: 'before\n', newText: 'after\n' }];
  f.event({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit fixture', kind: 'edit' });
  f.event({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'in_progress', content });
  assert(!f.entries().some(row => row.fileChanges?.length));
  f.event({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'failed', content });
  assert(!f.entries().some(row => row.fileChanges?.length));
  f.event({ sessionUpdate: 'tool_call', toolCallId: 'edit-2', title: 'Edit fixture', kind: 'edit', content });
  f.event({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-2', status: 'completed' });
  const edited = f.entries().find(row => row.id.endsWith(':edit-2'))!;
  assert.equal(edited.fileChanges?.[0]?.path, 'fixture.txt');
  assert.equal(edited.fileChanges?.[0]?.diff, '-before\n+after');
  const next = beginCursorTurn({ sessionId: f.session.sessionId, cwd: f.session.cwd!, text: 'Next request' });
  f.event({ sessionUpdate: 'tool_call', toolCallId: 'stale', title: 'Must not appear', kind: 'read' });
  next.update('Next answer'); next.finish();
  assert(!JSON.stringify(f.entries()).includes('Must not appear'));
});
