import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from '../../../codex-desktop/tests/fixture';
import { codexLogPathBySession } from '../../../sessions/scan/codex';
import { rememberPublishedCatalog } from '../../../session-catalog';
import { queued } from '../../../reply/in-flight';
import { handleCodexQuestionReply, publishCodexQuestions } from '../../index';
import type { RelayClient } from '../../../../../../packages/core/relay-client';
import type { Payload } from '../../../../../../packages/protocol/schema';

async function questionFixture(t: test.TestContext, uncertain = false) {
  const f = await fixture(t, uncertain ? (_request, socket) => socket.destroy() : undefined,
    { ownerFound: uncertain });
  const path = join(f.root, 'rollout.jsonl');
  writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call_cli_fixture',
      arguments: JSON.stringify({ questions: [{ title: 'Continue synthetic check?' }] }) } }) + '\n');
  codexLogPathBySession.set(f.session.sessionId, path);
  t.after(() => codexLogPathBySession.delete(f.session.sessionId));
  writeFileSync(join(f.root, 'codex.mjs'), '#!/usr/bin/env node\n' +
    "import { readFileSync, writeFileSync } from 'node:fs';\n" +
    "const args=process.argv.slice(2),text=readFileSync(0,'utf8');\n" +
    "const image=args.includes('-i')?readFileSync(args[args.indexOf('-i')+1],'utf8'):undefined;\n" +
    "const rows=JSON.parse(text.split('<send_user_message_question_reply>')[1].split('</send_user_message_question_reply>')[0]);\n" +
    "const document=rows[0].answer.includes('Attached files available locally:')?readFileSync(rows[0].answer.split('\\n').at(-1).split(': ').at(-1),'utf8'):undefined;\n" +
    `writeFileSync(${JSON.stringify(f.marker)}, JSON.stringify({args,text,image,document}));\n` +
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic continuation complete'}}));\n");
  const sent: Payload[] = [];
  const client = { room: 'cli-question-room', isConnected: true,
    send: async (payload: Payload) => { sent.push(payload); } } as unknown as RelayClient;
  rememberPublishedCatalog(client, { type: 'sessions.status', machine: 'Synthetic', sessions: [f.session],
    tokensRecent: 0, generatedAt: Date.now() });
  await publishCodexQuestions(client, [f.session]);
  const question = sent.find(p => p.type === 'agent.event');
  if (question?.type !== 'agent.event') throw Error('Question missing');
  const answer = { type: 'user.message' as const, sessionId: f.session.sessionId, requestId: question.requestId,
    messageId: 'cli-phone-one', text: 'Synthetic answer', createdAt: Date.now() };
  return { ...f, client, sent, answer };
}

test('an ownerless question resumes the same CLI chat with its native identity and attachments once', async t => {
  const f = await questionFixture(t);
  const answer = { ...f.answer, questionReplyFormat: 'attachments-v1' as const, attachments: [
    { name: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('Synthetic document').toString('base64') },
    { name: 'evidence.png', mimeType: 'image/png', data: Buffer.from('Synthetic image').toString('base64') },
  ] };
  await handleCodexQuestionReply(f.client, answer, async () => {}, 'phone-one');
  assert.equal(existsSync(f.marker), true, 'The explicit absent owner permits the existing serialized CLI path');
  const captured = JSON.parse(readFileSync(f.marker, 'utf8'));
  assert.deepEqual(captured.args.slice(0, 2), ['exec', 'resume']);
  assert.ok(captured.args.includes(f.session.sessionId));
  assert.equal(captured.image, 'Synthetic image');
  const rows = JSON.parse(captured.text.split('<send_user_message_question_reply>')[1]
    .split('</send_user_message_question_reply>')[0]);
  assert.equal(rows[0].questionItemId, JSON.stringify(['request_user_input_async', 'call_cli_fixture', 0]));
  assert.ok(rows[0].answer.startsWith('Synthetic answer\n\nAttached files available locally:\n'));
  assert.equal(captured.document, 'Synthetic document');
  writeFileSync(f.marker, 'unchanged');
  await handleCodexQuestionReply(f.client, { ...answer, messageId: 'cli-phone-two' }, async () => {}, 'phone-two');
  assert.equal(readFileSync(f.marker, 'utf8'), 'unchanged');
  await handleCodexQuestionReply(f.client, { ...answer, text: 'Different answer', messageId: 'cli-phone-three' },
    async () => {}, 'phone-three');
  assert.equal(readFileSync(f.marker, 'utf8'), 'unchanged');
  assert.ok(f.sent.some(p => p.type === 'delivery.receipt' && p.messageId === 'cli-phone-three' && p.status === 'rejected'));
});

test('a question answer waits for the existing run before continuing the same chat', async t => {
  const f = await questionFixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prior = queued(f.session.sessionId, async () => { await gate; return { ok: true, text: 'Earlier turn' }; });
  const answering = handleCodexQuestionReply(f.client, f.answer, async () => {}, 'phone');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(existsSync(f.marker), false);
  release();
  await prior;
  await answering;
  assert.equal(existsSync(f.marker), true);
});

test('uncertain native question admission never falls back to CLI or retries a second answer', async t => {
  const f = await questionFixture(t, true);
  await handleCodexQuestionReply(f.client, f.answer, async () => {}, 'phone');
  await handleCodexQuestionReply(f.client, { ...f.answer, messageId: 'retry-phone' }, async () => {}, 'phone');
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});

test('a failed CLI question continuation is not replayed by another controller', async t => {
  const f = await questionFixture(t);
  writeFileSync(join(f.root, 'codex.mjs'), '#!/usr/bin/env node\n' +
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(f.marker)},'started');\n` +
    "console.error('Synthetic failure after dispatch');process.exit(1);\n");
  await handleCodexQuestionReply(f.client, f.answer, async () => {}, 'phone');
  assert.equal(readFileSync(f.marker, 'utf8'), 'started');
  writeFileSync(f.marker, 'unchanged');
  await handleCodexQuestionReply(f.client, { ...f.answer, messageId: 'failed-retry' }, async () => {}, 'other-phone');
  assert.equal(readFileSync(f.marker, 'utf8'), 'unchanged');
});
