import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexActivity, scanCodex } from '..';

test('forked agents keep their native identity and exclude inherited parent history', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-forked-agents-'));
  const logs = join(root, 'logs');
  mkdirSync(logs);
  const previous = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = logs;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now();
  const parentMeta = { type: 'session_meta', timestamp: now - 10_000,
    payload: { id: 'parent', cwd: root, source: 'vscode' } };
  const parentRequest = { type: 'event_msg', timestamp: now - 9_000,
    payload: { type: 'user_message', message: 'Parent task' } };
  const save = (name: string, rows: unknown[]) => writeFileSync(join(logs, `${name}.jsonl`),
    rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  save('parent', [parentMeta, parentRequest]);
  for (let index = 1; index <= 3; index++) {
    save(`child-${index}`, [
      { type: 'session_meta', timestamp: now, payload: { id: `child-${index}`, cwd: root,
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1,
          agent_path: `/root/review_${index}`, agent_nickname: `Reviewer ${index}` } } } } },
      parentMeta, parentRequest,
      { type: 'event_msg', timestamp: now + index,
        payload: { type: 'user_message', message: `Review task ${index}` } },
      { type: 'event_msg', timestamp: now + index + 10,
        payload: { type: 'agent_message', message: `Review complete ${index}` } },
      { type: 'event_msg', timestamp: now + index + 20, payload: { type: 'task_complete' } },
    ]);
  }
  for (let pass = 0; pass < 2; pass++) {
    const catalog = scanCodex();
    assert.equal(catalog.sessions.length, 1, 'children must never replace their parent or become root tasks');
    const parent = catalog.sessions[0]!;
    assert.equal(parent.sessionId, 'parent');
    assert.deepEqual(parent.childThreads?.map(c => c.threadId).sort(), ['child-1', 'child-2', 'child-3']);
    assert.ok(parent.childThreads?.every(c => c.state === 'idle' && c.title !== 'Parent task'));
    const entries = codexActivity(parent);
    assert.ok(entries.some(e => e.kind === 'user' && e.text === 'Parent task' && !e.childThreadId));
    for (let index = 1; index <= 3; index++) {
      assert.ok(entries.some(e => e.text === `Review complete ${index}` && e.childThreadId === `child-${index}`));
      assert.equal(entries.filter(e => e.childThreadId === `child-${index}` && e.text === 'Parent task').length, 0);
    }
  }
});
