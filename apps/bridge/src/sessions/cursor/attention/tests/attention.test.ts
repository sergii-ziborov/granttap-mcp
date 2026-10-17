import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorActivity } from '../../index';
import { cursorQuestionText, cursorNoticeText, cursorNativeAttention } from '..';
import type { SessionInfo } from '../../../../../../../packages/protocol/schema';

const question = { title: 'Next step', questions: [{ id: 'next', prompt: 'What should happen next?',
  options: [{ id: 'test', label: 'Run tests' }, { id: 'review', label: 'Review changes' }], allowMultiple: false }] };
const session: SessionInfo = { sessionId: 'chat', agent: 'cursor', state: 'idle', startedAt: 1,
  lastActivityAt: 10, tokensSession: 0, tokensLastTurn: 0 };

test('Cursor questions expose the actual prompt and choices instead of an empty tool summary', () => {
  const text = cursorQuestionText('AskQuestion', question);
  assert.match(text ?? '', /What should happen next\?/);
  assert.match(text ?? '', /Run tests/);
  assert.match(text ?? '', /Review changes/);
  assert.equal(cursorQuestionText('Read', question), undefined);
  assert.equal(cursorQuestionText('ask_question', { questions: [] }), undefined);
  assert.equal(cursorQuestionText('ask_question', { questions: [{ prompt: 'x'.repeat(2001) }] }), undefined);
});

test('only explicit visible Cursor warnings/errors become notices; reasoning and unrelated rows stay private', () => {
  assert.equal(cursorNoticeText({ type: 'warning', message: 'The command needs permission.' }), 'The command needs permission.');
  assert.equal(cursorNoticeText({ role: 'system', type: 'error', message: { content: 'Provider connection failed.' } }), 'Provider connection failed.');
  assert.equal(cursorNoticeText({ type: 'tool_result', is_error: true, content: 'Tool failed.' }), 'Tool failed.');
  assert.equal(cursorNoticeText({ type: 'tool_result', is_error: false, content: 'Done.' }), undefined);
  assert.equal(cursorNoticeText({ type: 'thinking', text: 'private' }), undefined);
  assert.equal(cursorNoticeText({ type: 'warning', reasoning: 'private' }), undefined);
});

test('native question cards and errors are read from this exact composer without altering Cursor storage', t => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-attention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'state.vscdb');
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const composer = { fullConversationHeadersOnly: [{ bubbleId: 'question', createdAt: '2026-10-18T10:00:00Z' },
    { bubbleId: 'error', createdAt: '2026-10-18T10:00:01Z' }, { bubbleId: 'large-edit' }] };
  const bubble = { createdAt: '2026-10-18T10:00:00Z', toolFormerData: {
    name: 'ask_question', status: 'loading', params: JSON.stringify(question) } };
  const values = [['composerData:chat', composer], ['bubbleId:chat:question', bubble],
    ['bubbleId:chat:large-edit', { toolFormerData: { name: 'edit_file_v2', params: 'x'.repeat(2_200_000) } }],
    ['bubbleId:chat:error', { createdAt: '2026-10-18T10:00:01Z', errorDetails: { message: 'Connection interrupted.' } }],
    ['bubbleId:other:question', { toolFormerData: { name: 'ask_question', params: JSON.stringify({ questions: [{ prompt: 'Other chat' }] }) } }]];
  execFileSync('sqlite3', [db], { input: 'CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);' + values.map(([k,v]) =>
    `INSERT INTO cursorDiskKV VALUES(${quote(k as string)},${quote(JSON.stringify(v))});`).join('') });
  const entries = cursorNativeAttention(session, db);
  assert.equal(entries.length, 2);
  assert.match(entries[0]!.text, /What should happen next/);
  assert.equal(entries[1]!.text, 'Connection interrupted.');
  assert.ok(entries.every(e => e.id.startsWith('cursor-attention:chat:') && !e.text.includes('Other chat')));
  assert.deepEqual(cursorNativeAttention(session, db), entries);
  const prior = process.env.GRANTTAP_CURSOR_STATE_DB;
  process.env.GRANTTAP_CURSOR_STATE_DB = db;
  try {
    assert.ok(cursorActivity(session).some(e => e.text.includes('What should happen next')),
      'The public activity reader forwards native question cards even without a JSONL message.');
  } finally {
    if (prior == null) delete process.env.GRANTTAP_CURSOR_STATE_DB;
    else process.env.GRANTTAP_CURSOR_STATE_DB = prior;
  }
  assert.deepEqual(cursorNativeAttention({ ...session, sessionId: 'unknown' }, db), []);
  assert.deepEqual(cursorNativeAttention(session, join(root, 'missing')), []);
});
