import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { codexActivity, scanCodex } from '..';

const answer = JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'call_fixture', 0]),
  question: 'Which check should run?', answer: 'The physical check' }]);
const envelope = `<send_user_message_question_reply>\n${answer}\n</send_user_message_question_reply>`;

function fixture(t: TestContext, title: string, messages: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-question-title-'));
  const previous = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const day = join(root, '2026', '11', '06');
  mkdirSync(day, { recursive: true });
  const rows: unknown[] = [{ type: 'session_meta', payload: { id: 'question-title', cwd: root, title } }];
  for (const [i, message] of messages.entries()) rows.push({ type: 'event_msg',
    timestamp: new Date(1000 + i).toISOString(), payload: { type: 'user_message', message } });
  writeFileSync(join(day, 'rollout-question-title.jsonl'), rows.map(v => JSON.stringify(v)).join('\n'));
  return scanCodex().sessions.find(v => v.sessionId === 'question-title')!;
}

test('question reply envelopes cannot replace the task request, while the answer remains in history', t => {
  const session = fixture(t, envelope, ['Repair the connection', envelope]);
  assert.equal(session.title, 'Repair the connection');
  assert.ok(codexActivity(session).some(v => v.text === envelope));
});

test('a clipped JSON question title yields to the real request', t => {
  const session = fixture(t, answer.slice(0, 120), ['Repair the connection', envelope]);
  assert.equal(session.title, 'Repair the connection');
});

test('a question-only transcript stays untitled instead of exposing transport JSON', t => {
  const session = fixture(t, '', [envelope]);
  assert.equal(session.title, undefined);
  assert.ok(codexActivity(session).some(v => v.text === envelope));
});

test('ordinary JSON requests and quoted envelope examples remain usable names', t => {
  const request = '{"question":"Explain this schema"}';
  const session = fixture(t, request, [request]);
  assert.equal(session.title, request);
});
