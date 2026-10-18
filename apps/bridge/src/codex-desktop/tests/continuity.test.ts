import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { controlTaskSession } from '../../task-control';
import { deliverToSession } from '../../reply';
import { rememberPublishedCatalog } from '../../session-catalog';
import { handleInboundUserMessage } from '../../monitor/message-delivery';
import { fixture, respond } from './fixture';

test('native admission keeps document attachments available to the continuing turn and deduplicates restaging', async t => {
  const f = await fixture(t);
  const options = { messageId: randomUUID() };
  const document = { name: 'synthetic.txt', mimeType: 'text/plain', data: Buffer.from('Synthetic attachment').toString('base64') };
  const first = await deliverToSession(f.session, 'Synthetic document follow-up', 2_000, [document], options);
  assert.equal(first.ok, true);
  const text = f.requests.find(r => r.method === 'thread-follower-start-turn')?.params.turnStart.request.input[0].text;
  const path = text.split('\n').at(-1).split(': ').at(-1);
  assert.equal(await readFile(path, 'utf8').catch(() => 'missing'), 'Synthetic attachment',
    'the agent reads the file after the native turn admission, not before it');
  const repeated = await deliverToSession(f.session, 'Synthetic document follow-up', 2_000, [document], options);
  assert.equal(repeated.ok, true);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});

test('images reach native admission as local images and replay uses content identity', async t => {
  const f = await fixture(t);
  const image = { name: 'synthetic.png', mimeType: 'image/png', data: Buffer.from('Synthetic image').toString('base64') };
  const options = { messageId: randomUUID() };
  assert.equal((await deliverToSession(f.session, 'Synthetic image follow-up', 2_000, [image], options)).ok, true);
  const input = f.requests.find(r => r.method === 'thread-follower-start-turn')?.params.turnStart.request.input;
  assert.equal(input[1].type, 'localImage');
  assert.equal((await deliverToSession(f.session, 'Synthetic image follow-up', 2_000, [image], options)).ok, true);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
  assert.equal(existsSync(input[1].path), false, 'native admission has consumed the image file');
});

test('a phone-native receipt returns promptly without a fake assistant response or completed run digest', async t => {
  const f = await fixture(t);
  const payloads: any[] = [];
  const client = { room: 'native-qa', isConnected: true, setSessionKey: () => {},
    send: async (payload: any) => { if (payload.type !== 'session.key.grant') payloads.push(payload); },
    sendSession: async (payload: any) => { payloads.push(payload); } };
  rememberPublishedCatalog(client as never, { type: 'sessions.status', machine: 'Synthetic Mac',
    generatedAt: Date.now(), sessions: [f.session] });
  const message = { type: 'user.message' as const, messageId: randomUUID(),
    sessionId: f.session.sessionId, text: 'Synthetic phone-native follow-up', createdAt: Date.now() };
  let published = 0;
  const started = Date.now();
  assert.equal(await handleInboundUserMessage(client as never, message, async () => { published++; }), true);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(f.requests.find(r => r.method === 'thread-follower-start-turn')?.params.turnStart.request.clientUserMessageId,
    message.messageId);
  assert.ok(payloads.some(p => p.type === 'delivery.receipt' && p.status === 'accepted'));
  assert.equal(payloads.some(p => p.type === 'agent.event' || p.type === 'mesh.event'), false);
  assert.equal(published, 1);
  await handleInboundUserMessage(client as never, message, async () => {});
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});

test('Pause reaches the owning desktop with a native explicit user stop', async t => {
  const f = await fixture(t, (request, socket) => respond(socket, request, { ok: true, interruptedTurnId: 'native-turn' }));
  const receipts: Array<{ ok: boolean; text: string }> = [];
  await controlTaskSession({ type: 'session.control', sessionId: f.session.sessionId, action: 'pause',
    createdAt: Date.now() }, async (ok, text) => { receipts.push({ ok, text }); });
  const stop = f.requests.find(r => r.method === 'thread-follower-interrupt-turn');
  assert.equal(stop?.version, 3);
  assert.equal(stop?.targetClientId, 'native-owner');
  assert.deepEqual(stop?.params, { conversationId: f.session.sessionId, mode: 'user-stop', expectedTurnId: null });
  assert.equal(receipts[0]?.ok, true);
  assert.match(receipts[0]?.text ?? '', /Codex acknowledged/);
  assert.equal((await deliverToSession(f.session, 'Synthetic paused continuation', 2_000)).ok, false);
});

test('a headless writer conflict produces an actionable error instead of native paths and logs', async t => {
  const f = await fixture(t, undefined, { ownerFound: false });
  await writeFile(process.env.GRANTTAP_CODEX_BIN!, '#!/usr/bin/env node\n' +
    "console.error('/private/native/path: thread-store conflict: thread canary already has an active writer');process.exit(1);\n",
    { mode: 0o755 });
  const result = await deliverToSession(f.session, 'Synthetic headless conflict', 2_000);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /Codex already owns this chat/);
  assert.doesNotMatch(JSON.stringify(result), /private\/native|thread-store conflict/);
});
