import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from '../../codex-desktop/tests/fixture';
import { codexLogPathBySession } from '../../sessions/scan/codex';
import { rememberPublishedCatalog } from '../../session-catalog';
import { UserMessage, type Payload } from '../../../../../packages/protocol/schema';
import type { RelayClient } from '../../../../../packages/core/relay-client';
import { handleCodexQuestionReply, publishCodexQuestions } from '../index';

async function questionFixture(t: test.TestContext) {
  const f = await fixture(t);
  const path = join(f.root, 'question.jsonl');
  writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call_attachment_fixture',
      arguments: JSON.stringify({ questions: [{ title: 'Inspect the synthetic evidence?' }] }) } }) + '\n');
  codexLogPathBySession.set(f.session.sessionId, path);
  t.after(() => codexLogPathBySession.delete(f.session.sessionId));
  const sent: Payload[] = [];
  const client = { room: 'attachment-room', isConnected: true,
    send: async (payload: Payload) => { sent.push(payload); } } as unknown as RelayClient;
  rememberPublishedCatalog(client, { type: 'sessions.status', machine: 'Synthetic',
    sessions: [f.session], generatedAt: Date.now(), tokensRecent: 0 });
  await publishCodexQuestions(client, [f.session]);
  const event = sent.find(p => p.type === 'agent.event');
  assert.equal(event?.type, 'agent.event');
  if (event?.type !== 'agent.event') throw Error('Question publication missing');
  return { ...f, client, event, sent };
}

test('native questions advertise their supported attachment reply format without changing identity', async t => {
  const f = await questionFixture(t);
  const event = f.event as typeof f.event & { questionReplyFormat?: string };
  assert.equal(event.questionReplyFormat, 'attachments-v1');
  await publishCodexQuestions(f.client, [f.session], { replay: true });
  const repeated = f.sent.filter(p => p.type === 'agent.event');
  assert.equal(repeated.length, 2);
  assert.equal(repeated[1]?.type === 'agent.event' && repeated[1].requestId, f.event.requestId);
});

test('the public user message schema preserves explicit attachment-capable question replies', () => {
  const message = UserMessage.parse({ type: 'user.message', text: 'Synthetic evidence',
    requestId: 'codex-question-0123456789abcdef0123456789abcdef', createdAt: Date.now(),
    questionReplyFormat: 'attachments-v1' as const }) as unknown as { questionReplyFormat?: string };
  assert.equal(message.questionReplyFormat, 'attachments-v1');
});

test('an attachment-capable answer delivers its image and durable document to the original native item once', async t => {
  const f = await questionFixture(t);
  const document = { name: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('Synthetic document bytes').toString('base64') };
  const image = { name: 'evidence.png', mimeType: 'image/png', data: Buffer.from('Synthetic image bytes').toString('base64') };
  const message = { type: 'user.message' as const, requestId: f.event.requestId,
    sessionId: f.session.sessionId, messageId: 'question-attachment-phone-one', createdAt: Date.now(),
    text: 'Inspect these attached files', attachments: [document, image], questionReplyFormat: 'attachments-v1' as const };
  assert.equal(await handleCodexQuestionReply(f.client, message, async () => {}, 'phone'), true);
  const requests = f.requests.filter(r => r.method === 'thread-follower-start-turn');
  assert.equal(requests.length, 1);
  const input = requests[0]?.params.turnStart.request;
  assert.equal(input.clientUserMessageId, f.event.requestId);
  assert.ok(input.input[0].text.includes('call_attachment_fixture'));
  assert.ok(input.input[0].text.includes('Inspect these attached files'));
  assert.equal(input.input[1].type, 'localImage');
  const reply = JSON.parse(input.input[0].text.split('<send_user_message_question_reply>')[1]
    .split('</send_user_message_question_reply>')[0])[0];
  const file = reply.answer.split('\n').at(-1).split(': ').at(-1);
  assert.equal(readFileSync(file, 'utf8'), 'Synthetic document bytes');
  await handleCodexQuestionReply(f.client, { ...message, messageId: 'question-attachment-phone-two' }, async () => {}, 'phone');
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
  assert.ok(f.sent.some(p => p.type === 'delivery.receipt' && p.messageId === message.messageId && p.status === 'accepted'));
  assert.equal(existsSync(f.marker), false, 'The answer never starts a competing CLI writer');
});

test('a document answer is observed as the original native question reply and clears its card across controllers', async t => {
  const f = await questionFixture(t);
  const document = { name: 'native-evidence.txt', mimeType: 'text/plain', data: Buffer.from('Synthetic document').toString('base64') };
  await handleCodexQuestionReply(f.client, { type: 'user.message', requestId: f.event.requestId,
    sessionId: f.session.sessionId, messageId: 'native-observed-attachment', createdAt: Date.now(),
    text: 'Inspect the evidence', attachments: [document], questionReplyFormat: 'attachments-v1' }, async () => {}, 'phone');
  const nativeText = f.requests.find(r => r.method === 'thread-follower-start-turn')?.params.turnStart.request.input[0].text;
  assert.equal(typeof nativeText, 'string');
  appendFileSync(join(f.root, 'question.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(),
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: nativeText }] } }) + '\n');
  f.sent.length = 0;
  await publishCodexQuestions(f.client, [f.session], { replay: true, peerPublicKey: 'other-phone' });
  const resolved = f.sent.find(p => p.type === 'approval.resolved');
  assert.equal(resolved?.type === 'approval.resolved' && resolved.nativeUiCleared, true);
  assert.equal(f.sent.filter(p => p.type === 'agent.event').length, 0);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});
