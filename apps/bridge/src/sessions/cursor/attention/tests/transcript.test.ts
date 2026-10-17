import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorActivity, scanCursor } from '../../index';

test('the public Cursor transcript includes question choices and failed-tool notices on the first read', t => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-visible-'));
  const env = ['GRANTTAP_CURSOR_STATE_DB', 'GRANTTAP_CURSOR_TRANSCRIPTS_DIR'];
  const prior = env.map(key => process.env[key]);
  t.after(() => { env.forEach((key, i) => { if (prior[i] == null) delete process.env[key]; else process.env[key] = prior[i]; });
    rmSync(root, { recursive: true, force: true }); });
  process.env.GRANTTAP_CURSOR_STATE_DB = join(root, 'missing.db');
  process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR = root;
  mkdirSync(join(root, 'chat'));
  writeFileSync(join(root, 'chat/chat.jsonl'), [
    { role: 'user', timestamp: '2026-10-18T10:00:00Z', message: { content: 'Continue the synthetic task.' } },
    { role: 'assistant', timestamp: '2026-10-18T10:00:01Z', message: { content: [
      { type: 'thinking', text: 'Never display this.' },
      { type: 'tool_use', name: 'AskQuestion', input: { questions: [{ prompt: 'What next?', options: [{ label: 'Test' }] }] } }] } },
    { role: 'user', timestamp: '2026-10-18T10:00:02Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'call', is_error: true, content: 'The command needs permission.' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const session = scanCursor().sessions.find(s => s.sessionId === 'chat');
  assert.ok(session);
  const entries = cursorActivity(session);
  assert.ok(entries.some(e => e.kind === 'message' && e.text.includes('What next?') && e.text.includes('Test')));
  assert.ok(entries.some(e => e.kind === 'status' && e.text === 'The command needs permission.'));
  assert.equal(entries.some(e => e.text.includes('Never display this.')), false);
  assert.equal(entries.find(e => e.text.includes('What next?'))?.createdAt, Date.parse('2026-10-18T10:00:01Z'));
});
