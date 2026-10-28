import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grokActivity, scanGrok } from '../grok';

test('Grok persisted updates retain visible requests and answers after model-history compaction', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-grok-updates-'));
  const directory = join(root, 'project', 'persisted-session');
  mkdirSync(directory, { recursive: true });
  const previous = process.env.GRANTTAP_GROK_SESSIONS_DIR;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    else process.env.GRANTTAP_GROK_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Math.floor(Date.now() / 1_000);
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'persisted-session' },
    created_at: new Date((now - 100) * 1_000).toISOString(), updated_at: new Date(now * 1_000).toISOString() }));
  writeFileSync(join(directory, 'chat_history.jsonl'), JSON.stringify({ type: 'user',
    synthetic_reason: 'compacted_context', content: 'private model-only summary' }) + '\n');
  const updates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Original request' }, _meta: { promptIndex: 0 } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Original answer' } },
    { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', prompt_id: 'first' },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Follow-up request' }, _meta: { promptIndex: 1 } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Actual ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'follow-up answer' } },
    { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', prompt_id: 'second' },
  ];
  writeFileSync(join(directory, 'updates.jsonl'), updates.map((update, i) => JSON.stringify({
    timestamp: now - 20 + i, method: 'session/update', params: { sessionId: 'persisted-session', update },
  })).join('\n') + '\n');
  const session = scanGrok().sessions[0]!;
  const entries = grokActivity(session, true);
  assert.deepEqual(entries.map(row => [row.kind, row.text]), [
    ['user', 'Original request'], ['final', 'Original answer'],
    ['user', 'Follow-up request'], ['final', 'Actual follow-up answer'],
  ]);
  assert.doesNotMatch(JSON.stringify(entries), /private/);
  assert.equal(new Set(entries.map(row => row.id)).size, 4);
  assert.ok(entries[3]!.createdAt > entries[2]!.createdAt);
});
