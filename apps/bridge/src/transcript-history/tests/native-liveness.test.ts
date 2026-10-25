import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexLogPathBySession } from '../../sessions/scan/codex/shared';
import { desktopTaskActivity } from '../../../../mcp/src/desktop/task-activity';

test('native activity uses the current Codex turn rather than a previous durable execution close', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-state-'));
  const sessionId = 'native-state-fixture';
  const path = join(root, 'rollout.jsonl');
  const storePath = join(root, 'mesh.json');
  const now = Date.now();
  const row = (at: number, type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + '\n';
  writeFileSync(path, row(now - 10_000, 'session_meta', { id: sessionId, cwd: root })
    + row(now - 9_000, 'event_msg', { type: 'task_complete' })
    + row(now - 1_000, 'event_msg', { type: 'task_started', turn_id: 'resumed' })
    + row(now, 'response_item', { type: 'message', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'Synthetic work is running.' }] }));
  codexLogPathBySession.set(sessionId, path);
  t.after(() => { codexLogPathBySession.delete(sessionId); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: 'p', name: 'Test', canonicalRepositoryId: 'repo', createdAt: 1 }],
    tasks: [{ taskId: 't', projectId: 'p', title: 'Test', goal: 'Test', state: 'working',
      ownerSessionId: sessionId, createdAt: 1, updatedAt: now }],
    executions: [{ taskId: 't', sessionId, provider: 'codex', computerId: 'local',
      workspace: root, startedAt: now - 10_000, endedAt: now - 9_000 }] }));
  const before = desktopTaskActivity({ project_id: 'p', task_id: 't' }, storePath);
  assert.equal(before?.state, 'working');
  assert.equal(before?.entries.at(-1)?.text, 'Synthetic work is running.');
  const stableId = before?.entries.at(-1)?.id;
  appendFileSync(path, row(now + 1, 'event_msg', { type: 'task_complete', turn_id: 'resumed' }));
  const after = desktopTaskActivity({ project_id: 'p', task_id: 't' }, storePath);
  assert.equal(after?.state, 'idle');
  assert.equal(after?.entries.at(-1)?.id, stableId);
});
