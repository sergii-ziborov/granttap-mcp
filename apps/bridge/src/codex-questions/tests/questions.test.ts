import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Payload, SessionInfo, UserMessage } from '../../../../../packages/protocol/schema';
import { codexLogPathBySession } from '../../sessions/scan/codex/shared';
import { publishCodexQuestions, handleCodexQuestionReply } from '../index';
import type { RelayClient } from '../../../../../packages/core/relay-client';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-codex-question-'));
  const before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const session: SessionInfo = { sessionId: 'question-fixture', agent: 'codex', state: 'working',
    projectId: 'project', taskId: 'task', startedAt: Date.now(), lastActivityAt: Date.now(),
    tokensSession: 0, tokensLastTurn: 0 };
  const path = join(root, 'rollout.jsonl');
  const row = (payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(),
    type: 'response_item', payload }) + '\n';
  writeFileSync(path, row({ type: 'function_call', name: 'request_user_input_async', call_id: 'call_fixture',
    arguments: JSON.stringify({ questions: [{ title: 'Which check?', options: ['Simulator', 'Node'] },
      { title: 'Any extra detail?', options: null }] }) }));
  codexLogPathBySession.set(session.sessionId, path);
  const sent: Array<{ payload: Payload; options: any }> = [];
  const client = { room: 'test-room', send: async (payload: Payload, _to: unknown, options: unknown) => {
    sent.push({ payload, options });
  } } as unknown as RelayClient;
  t.after(() => {
    if (before === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = before;
    codexLogPathBySession.delete(session.sessionId); rmSync(root, { recursive: true, force: true });
  });
  return { root, path, row, session, client, sent };
}

test('Codex async question cards reach the phone with stable identity, options and exact Task scope', async t => {
  const f = fixture(t);
  const raw = readFileSync(f.path, 'utf8');
  await publishCodexQuestions(f.client, [f.session]);
  const questions = f.sent.filter(x => x.payload.type === 'agent.event');
  assert.equal(questions.length, 2);
  const first = questions[0]!.payload;
  assert.equal(first.type, 'agent.event');
  if (first.type !== 'agent.event') return;
  assert.equal(first.kind, 'question');
  assert.equal(first.sessionId, f.session.sessionId);
  assert.equal(first.taskId, 'task');
  assert.equal(first.projectId, 'project');
  assert.ok(first.text.includes('Which check?') && first.text.includes('Simulator') && first.text.includes('Node'));
  assert.equal(questions[0]?.options.wake, true);
  f.sent.length = 0;
  await publishCodexQuestions(f.client, [f.session]);
  assert.equal(f.sent.length, 0, 'A scan must not repeatedly notify the same question.');
  await publishCodexQuestions(f.client, [f.session], { replay: true, peerPublicKey: 'opening-phone' });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0]?.options.peerPublicKey, 'opening-phone');
  assert.equal(readFileSync(f.path, 'utf8'), raw, 'Provider files are never rewritten.');
});

test('a reply observed in the native transcript clears only that question without another dispatch', async t => {
  const f = fixture(t);
  await publishCodexQuestions(f.client, [f.session]);
  const first = f.sent[0]!.payload;
  assert.equal(first.type, 'agent.event');
  if (first.type !== 'agent.event') return;
  const answer = '<send_user_message_question_reply>\n' + JSON.stringify([{
    questionItemId: JSON.stringify(['request_user_input_async', 'call_fixture', 0]),
    question: 'Which check?', answer: 'Simulator' }]) + '\n</send_user_message_question_reply>';
  appendFileSync(f.path, f.row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: answer }] }));
  f.sent.length = 0;
  await publishCodexQuestions(f.client, [f.session]);
  const resolved = f.sent.find(x => x.payload.type === 'approval.resolved')?.payload;
  assert.equal(resolved?.type, 'approval.resolved');
  if (resolved?.type !== 'approval.resolved') return;
  assert.equal(resolved.requestId, first.requestId);
  assert.equal(resolved.nativeUiCleared, true);
  f.sent.length = 0;
  await publishCodexQuestions(f.client, [f.session], { replay: true });
  assert.equal(f.sent.filter(x => x.payload.type === 'agent.event').length, 1);
  const retry: UserMessage = { type: 'user.message', messageId: 'reply-fixture',
    sessionId: f.session.sessionId, requestId: first.requestId, text: 'Simulator', createdAt: Date.now() };
  assert.equal(await handleCodexQuestionReply(f.client, retry, async () => {}, 'phone'), true);
  assert.ok(f.sent.some(x => x.payload.type === 'delivery.receipt' && x.payload.status === 'rejected'));
});

test('another session, room or unrelated correlated reply cannot answer a native question', async t => {
  const f = fixture(t);
  await publishCodexQuestions(f.client, [f.session]);
  const first = f.sent[0]!.payload;
  assert.equal(first.type, 'agent.event');
  if (first.type !== 'agent.event') return;
  const base: UserMessage = { type: 'user.message', requestId: first.requestId,
    sessionId: f.session.sessionId, text: 'Simulator', createdAt: Date.now() };
  assert.equal(await handleCodexQuestionReply(f.client, { ...base, sessionId: 'other' }, async () => {}, 'phone'), false);
  const other = { ...f.client, room: 'other-room' } as unknown as RelayClient;
  assert.equal(await handleCodexQuestionReply(other, base, async () => {}, 'phone'), false);
  assert.equal(await handleCodexQuestionReply(f.client, { ...base, requestId: 'unrelated' }, async () => {}, 'phone'), false);
});

test('a phone answer carries the native item identity through ordinary scoped delivery and is not resolved early', async t => {
  const f = fixture(t);
  await publishCodexQuestions(f.client, [f.session]);
  const first = f.sent[0]!.payload;
  assert.equal(first.type, 'agent.event');
  if (first.type !== 'agent.event') return;
  const base: UserMessage = { type: 'user.message', messageId: 'original-phone-message',
    requestId: first.requestId, sessionId: f.session.sessionId, text: 'Simulator', createdAt: Date.now() };
  let forwarded: UserMessage | undefined;
  f.sent.length = 0;
  const deliver = async (_client: RelayClient, message: UserMessage, _publish: () => Promise<void>, peer?: string,
    native?: { messageId: string; nativeOnly: true }) => {
    forwarded = message; assert.equal(peer, 'phone');
    assert.equal(native?.messageId, first.requestId);
    assert.equal(native?.nativeOnly, true);
    return true;
  };
  assert.equal(await handleCodexQuestionReply(f.client, base, async () => {}, 'phone', deliver), true);
  assert.equal(forwarded?.messageId, base.messageId);
  assert.equal(forwarded?.requestId, undefined);
  assert.equal(forwarded?.sessionId, f.session.sessionId);
  assert.ok(forwarded?.text.includes(JSON.stringify(['request_user_input_async', 'call_fixture', 0]).replaceAll('"', '\\"')));
  assert.ok(forwarded?.text.includes('Simulator'));
  assert.equal(f.sent.length, 0, 'Native transcript observation confirms resolution, not starting delivery.');
  for (const message of [{ ...base, text: '' }, { ...base, text: 'x'.repeat(4_001) },
    { ...base, attachments: [{ name: 'a.txt', mimeType: 'text/plain', data: 'YQ==' }] }]) {
    assert.equal(await handleCodexQuestionReply(f.client, message, async () => {}, 'phone', deliver), false);
  }
  assert.equal(await handleCodexQuestionReply(f.client, base, async () => {}), false);
});

test('native question expiry is explicit and does not claim the native card was answered', async t => {
  const f = fixture(t);
  await publishCodexQuestions(f.client, [f.session]);
  const first = f.sent[0]!.payload;
  assert.equal(first.type, 'agent.event');
  if (first.type !== 'agent.event') return;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 24 * 60 * 60_000 + 1);
  f.sent.length = 0;
  await publishCodexQuestions(f.client, [f.session]);
  assert.ok(f.sent.every(x => x.payload.type === 'approval.resolved' && x.payload.status === 'expired'
    && x.payload.nativeUiCleared === false));
  assert.equal(await handleCodexQuestionReply(f.client, { type: 'user.message', messageId: 'late-answer',
    requestId: first.requestId, sessionId: f.session.sessionId, text: 'Simulator', createdAt: Date.now() },
  async () => {}, 'phone'), true);
  assert.ok(f.sent.some(x => x.payload.type === 'delivery.receipt' && x.payload.status === 'rejected'));
});
