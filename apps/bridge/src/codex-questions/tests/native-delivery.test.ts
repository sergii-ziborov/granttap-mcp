import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from '../../codex-desktop/tests/fixture';
import { deliverToSession } from '../../reply';
import { codexLogPathBySession } from '../../sessions/scan/codex';
import { rememberPublishedCatalog } from '../../session-catalog';
import { publishCodexQuestions, handleCodexQuestionReply } from '../index';
import type { RelayClient } from '../../../../../packages/core/relay-client';
import type { Payload } from '../../../../../packages/protocol/schema';

test('a native answer reaches the owning Codex conversation once across two phone message IDs', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'rollout.jsonl');
  writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call_native_fixture',
      arguments: JSON.stringify({ questions: [{ title: 'Continue synthetic check?', options: ['Yes', 'No'] }] }) } }) + '\n');
  codexLogPathBySession.set(f.session.sessionId, path);
  t.after(() => codexLogPathBySession.delete(f.session.sessionId));
  const sent: Payload[] = [];
  const client = { room: 'fixture-room', isConnected: true,
    send: async (payload: Payload) => { sent.push(payload); } } as unknown as RelayClient;
  rememberPublishedCatalog(client, { type: 'sessions.status', machine: 'Test', sessions: [f.session],
    tokensRecent: 0, generatedAt: Date.now() });
  await publishCodexQuestions(client, [f.session]);
  const question = sent.find(p => p.type === 'agent.event');
  assert.equal(question?.type, 'agent.event');
  if (question?.type !== 'agent.event') return;
  const answer = { type: 'user.message' as const, sessionId: f.session.sessionId, requestId: question.requestId,
    messageId: 'first-phone-message', text: 'Yes', createdAt: Date.now() };
  assert.equal(await handleCodexQuestionReply(client, answer, async () => {}, 'phone-one'), true);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
  const input = f.requests.find(r => r.method === 'thread-follower-start-turn')?.params.turnStart.request;
  assert.equal(input?.clientUserMessageId, question.requestId);
  assert.ok(input?.input[0].text.includes('send_user_message_question_reply'));
  assert.ok(input?.input[0].text.includes('call_native_fixture'));
  assert.ok(sent.some(p => p.type === 'delivery.receipt' && p.messageId === answer.messageId && p.status === 'accepted'));
  await handleCodexQuestionReply(client, { ...answer, messageId: 'second-phone-message', text: 'No' },
    async () => {}, 'phone-two');
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
  assert.ok(sent.some(p => p.type === 'delivery.receipt' && p.messageId === 'second-phone-message' && p.status === 'rejected'));
  assert.equal(existsSync(f.marker), false);
});

test('a closed Codex desktop question refuses a competing headless writer', async t => {
  const f = await fixture(t, undefined, { ownerFound: false });
  const result = await deliverToSession(f.session, 'Synthetic native-only answer', 2_000, [],
    { messageId: 'native-question-fixture', nativeOnly: true });
  assert.equal(result.ok, false);
  assert.equal(existsSync(f.marker), false);
});
