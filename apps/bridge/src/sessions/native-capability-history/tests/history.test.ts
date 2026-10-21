import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexCapabilityHistory } from '..';
import { scanCapabilityUsage } from '../../index';
import type { SessionInfo } from '../../../../../../packages/protocol/schema';

test('native MCP history retains recorded calls outside a transcript window and exact execution scope', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT,
    rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,
    updated_at_ordinal INTEGER);
    CREATE INDEX idx_updated ON thread_items(thread_id,updated_at_ordinal);
    CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_ordinal INTEGER);`);
  db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?)').run('native-task', 352);
  const put = db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)');
  const now = Date.now() - 1000;
  for (let i = 0; i < 350; i++) {
    put.run('native-task', `call-${i}`, 'mcpToolCall', JSON.stringify({ type: 'mcpToolCall',
      id: `call-${i}`, server: 'code-review', tool: 'review', status: i === 0 ? 'failed' : 'completed',
      arguments: { secret: 'private-argument' }, result: { content: [{ text: 'private-output' }] },
      durationMs: 25 }), i, now + i, now + i, now + i + 25, i);
  }
  put.run('foreign-task', 'foreign', 'mcpToolCall', JSON.stringify({ server: 'other-project', tool: 'x' }),
    351, now, now, now, 351);
  db.close();
  const sessions = [{ agent: 'codex', sessionId: 'native-task' }] as SessionInfo[];
  const first = await readCodexCapabilityHistory(sessions, root);
  assert.deepEqual(first.scopes, ['native-task']);
  assert.equal(first.summaries.length, 1);
  assert.deepEqual(first.summaries[0], { sessionId: 'native-task', agent: 'codex', kind: 'mcp',
    name: 'code-review', count: 350, failures: 1, cancelled: 0, lastUsedAt: now + 349,
    durationMs: 8750, durationCount: 350, source: 'native-history' });
  assert.equal(first.events.length, 350);
  assert.ok(first.events.every(e => e.name === 'code-review' && e.sessionId === 'native-task'));
  assert.doesNotMatch(JSON.stringify(first), /private-argument|private-output|foreign-task/);
  const status = scanCapabilityUsage(sessions, first);
  assert.equal(status.executionSummaries?.[0]?.count, 350);
  assert.equal(status.totals?.find(r => r.windowHours === 24 && r.name === 'code-review')?.count, 350);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 48 * 1024);
  const reopened = await readCodexCapabilityHistory(sessions, root);
  assert.deepEqual(reopened.summaries, first.summaries, 'read-only reopen preserves native evidence');
  const writer = new DatabaseSync(join(root, 'thread_history_1.sqlite'));
  writer.prepare('UPDATE thread_items SET item_json=?,updated_at_ordinal=? WHERE item_id=?').run(
    JSON.stringify({ server: 'code-review', tool: 'review', status: 'completed', durationMs: 125 }), 353, 'call-0');
  writer.exec('UPDATE thread_history_projection_state SET next_rollout_ordinal=354');
  writer.close();
  const updated = await readCodexCapabilityHistory([...sessions, { agent: 'codex', sessionId: 'unused' } as SessionInfo], root);
  assert.equal(updated.summaries[0]?.count, 350, 'completion updates replace their own invocation');
  assert.equal(updated.summaries[0]?.failures, 0);
  assert.equal(updated.summaries[0]?.durationMs, 8850);
});

test('missing native history remains unknown and never creates a use from configuration', async () => {
  const result = await readCodexCapabilityHistory([{ agent: 'codex', sessionId: 'no-history' }] as SessionInfo[],
    join(tmpdir(), 'granttap-does-not-exist'));
  assert.deepEqual(result, { scopes: [], events: [], summaries: [] });
});
