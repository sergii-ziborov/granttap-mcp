import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Payload, SessionInfo, UserMessage } from '../../../../../packages/protocol/schema';
import type { RelayClient } from '../../../../../packages/core/relay-client';
import { claudeLogPathBySession } from '../../sessions/scan/claude/shared';
import { deferredQuestionOutput } from '../../claude-questions';
import { DEFERRED_QUESTION_REASON, handleClaudeOpenQuestionReply, publishClaudeOpenQuestions,
  replayClaudeOpenQuestion } from '../index';

let clock = Date.now() - 60_000;
const row = (type: string, content: unknown, extra: object = {}) => JSON.stringify({ type,
  timestamp: new Date(clock += 1_000).toISOString(), message: { role: type, content }, ...extra }) + '\n';
const wrapUp = (id: string, ask: string, actions: object[]) => row('assistant',
  [{ type: 'tool_use', id, name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Done.', ask, actions } }]);
const result = (id: string, content: unknown) => row('user', [{ type: 'tool_result', tool_use_id: id, content }]);

function fixture(t: test.TestContext, state: SessionInfo['state'] = 'idle') {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-question-'));
  const before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const session: SessionInfo = { sessionId: `open-question-${state}-${clock}`, agent: 'claude', state,
    projectId: 'project', taskId: 'task', startedAt: Date.now(), lastActivityAt: Date.now(),
    tokensSession: 0, tokensLastTurn: 0 };
  const path = join(root, `${session.sessionId}.jsonl`);
  writeFileSync(path, row('user', 'Prepare the release') + wrapUp('toolu_ask', 'Approve design R2?',
    [{ label: 'Yes, approve' }, { action: 'commit' }]) + result('toolu_ask', 'Shown')
    + row('assistant', [{ type: 'text', text: 'Waiting for you.' }], { stop: 'end_turn' }));
  claudeLogPathBySession.set(session.sessionId, path);
  const sent: Array<{ payload: Payload; options: any }> = [];
  const client = { room: 'test-room', send: async (payload: Payload, _to: unknown, options: unknown) => {
    sent.push({ payload, options });
  } } as unknown as RelayClient;
  t.after(() => {
    if (before === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = before;
    claudeLogPathBySession.delete(session.sessionId);
    rmSync(root, { recursive: true, force: true });
  });
  const events = () => sent.filter(x => x.payload.type === 'agent.event').map(x => x.payload)
    .filter((p): p is Extract<Payload, { type: 'agent.event' }> => p.type === 'agent.event');
  const resolved = () => sent.map(x => x.payload)
    .filter((p): p is Extract<Payload, { type: 'approval.resolved' }> => p.type === 'approval.resolved');
  return { root, path, session, client, sent, events, resolved };
}

test('an end-of-turn ask reaches the phone once, with reply buttons as choices and no app actions', async t => {
  const f = fixture(t);
  const raw = readFileSync(f.path, 'utf8');
  await publishClaudeOpenQuestions(f.client, [f.session]);
  const [card] = f.events();
  assert.equal(card?.kind, 'question');
  assert.equal(card?.agent, 'claude');
  assert.equal(card?.sessionId, f.session.sessionId);
  assert.equal(card?.taskId, 'task');
  assert.equal(card?.text, 'Approve design R2?\n• Yes, approve');
  assert.match(card?.requestId ?? '', /^claude-open-question-[a-f0-9]{32}$/);
  assert.equal(f.sent[0]?.options.wake, true);
  assert.ok(f.sent[0]!.options.ttlMs > 6 * 24 * 60 * 60_000, 'The card outlives a quick approval window.');
  f.sent.length = 0;
  await publishClaudeOpenQuestions(f.client, [f.session, f.session]);
  assert.equal(f.sent.length, 0, 'Repeat scans must not notify again.');
  await publishClaudeOpenQuestions(f.client, [f.session], { replay: true, peerPublicKey: 'opening-phone' });
  assert.equal(f.events().length, 1);
  assert.equal(f.sent[0]?.options.peerPublicKey, 'opening-phone');
  f.sent.length = 0;
  assert.equal(await replayClaudeOpenQuestion(f.client, card!.requestId!, 'tapped-phone'), true);
  assert.deepEqual(f.events().map(e => e.requestId), [card!.requestId], 'A notification tap restores that card.');
  assert.equal(await replayClaudeOpenQuestion(f.client, card!.requestId!), false, 'Only to a known phone.');
  assert.equal(readFileSync(f.path, 'utf8'), raw, 'Provider files are never rewritten.');
});

test('a message from the person at the computer closes the card on every device', async t => {
  const f = fixture(t);
  await publishClaudeOpenQuestions(f.client, [f.session]);
  const requestId = f.events()[0]!.requestId;
  appendFileSync(f.path, row('user', 'Yes, approve'));
  f.sent.length = 0;
  await publishClaudeOpenQuestions(f.client, [{ ...f.session, state: 'working' }]);
  assert.deepEqual(f.resolved().map(r => [r.requestId, r.status, r.nativeUiCleared]), [[requestId, 'applied', true]]);
  f.sent.length = 0;
  await publishClaudeOpenQuestions(f.client, [{ ...f.session, state: 'working' }]);
  assert.equal(f.sent.length, 0, 'A closed card is not resent, and the working chat is no longer read.');
});

test('a newer question replaces the older one', async t => {
  const f = fixture(t);
  await publishClaudeOpenQuestions(f.client, [f.session]);
  const older = f.events()[0]!.requestId;
  appendFileSync(f.path, row('user', [{ type: 'text', text: '<task-notification>done</task-notification>' }])
    + wrapUp('toolu_next', 'Push the release commit?', [{ label: 'Push' }, { label: 'Not now' }]));
  f.sent.length = 0;
  await publishClaudeOpenQuestions(f.client, [f.session]);
  assert.deepEqual(f.resolved().map(r => r.requestId), [older]);
  assert.equal(f.events()[0]?.text, 'Push the release commit?\n• Push\n• Not now');
});

test('a working chat with no open card is not read for questions', async t => {
  const f = fixture(t, 'working');
  await publishClaudeOpenQuestions(f.client, [f.session]);
  assert.equal(f.sent.length, 0);
});

test('an AskUserQuestion the hook handed to the phone becomes a lasting card; a local answer does not', async t => {
  const f = fixture(t);
  appendFileSync(f.path, row('user', 'Next')
    + row('assistant', [{ type: 'tool_use', id: 'toolu_local', name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which check?', options: [{ label: 'Simulator' }] }] } }])
    + result('toolu_local', 'User answered: Simulator')
    + row('assistant', [{ type: 'tool_use', id: 'toolu_phone', name: 'AskUserQuestion',
      input: { questions: [{ question: 'Ship today?', options: [{ label: 'Yes' }, { label: 'Tomorrow' }] }] } }])
    + result('toolu_phone', [{ type: 'text', text: DEFERRED_QUESTION_REASON }]));
  await publishClaudeOpenQuestions(f.client, [f.session]);
  assert.deepEqual(f.events().map(e => e.text), ['Ship today?\n• Yes\n• Tomorrow']);
});

test('the hook defers only a question the phone saw and left unanswered', () => {
  const base = { type: 'approval.decision' as const, requestId: 'q', decision: 'deny' as const, decidedAt: 1 };
  assert.equal(deferredQuestionOutput({ ...base, decidedBy: 'expired' })?.hookSpecificOutput
    .permissionDecisionReason, DEFERRED_QUESTION_REASON);
  assert.equal(deferredQuestionOutput({ ...base, decidedBy: 'unreachable' }), undefined);
  assert.equal(deferredQuestionOutput({ ...base, decidedBy: 'phone' }), undefined);
});

test('a phone reply is an ordinary message to that chat; a late one is refused', async t => {
  const f = fixture(t);
  await publishClaudeOpenQuestions(f.client, [f.session]);
  const requestId = f.events()[0]!.requestId!;
  const delivered: UserMessage[] = [];
  const deliver = async (_c: RelayClient, message: UserMessage) => { delivered.push(message); return true; };
  const reply: UserMessage = { type: 'user.message', messageId: 'reply-1', requestId,
    sessionId: f.session.sessionId, text: 'Yes, approve', createdAt: Date.now() };
  assert.equal(await handleClaudeOpenQuestionReply(f.client, reply, async () => {}, 'phone-key', deliver), true);
  assert.deepEqual(delivered.map(m => [m.text, m.requestId, m.messageId, m.sessionId]),
    [['Yes, approve', undefined, 'reply-1', f.session.sessionId]]);
  assert.equal(await handleClaudeOpenQuestionReply(f.client, { ...reply, sessionId: 'other' },
    async () => {}, 'phone-key', deliver), false, 'A reply naming another chat is not this question.');
  appendFileSync(f.path, row('user', 'Yes, approve'));
  f.sent.length = 0;
  assert.equal(await handleClaudeOpenQuestionReply(f.client, { ...reply, messageId: 'reply-2' },
    async () => {}, 'phone-key', deliver), true);
  assert.equal(delivered.length, 1);
  const receipt = f.sent.find(x => x.payload.type === 'delivery.receipt')?.payload;
  assert.equal(receipt?.type === 'delivery.receipt' && receipt.status, 'rejected');
  assert.equal(f.resolved()[0]?.requestId, requestId);
});

test('a question found long after it was asked arrives quietly, and one past a week never arrives', async t => {
  const f = fixture(t);
  const write = (path: string, at: number, id: string, ask: string) => writeFileSync(path, JSON.stringify({
    type: 'assistant', timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{
      type: 'tool_use', id, name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Done.', ask } }] } }) + '\n');
  write(f.path, Date.now() - 2 * 60 * 60_000, 'toolu_old', 'Still want this?');
  await publishClaudeOpenQuestions(f.client, [f.session]);
  assert.equal(f.events()[0]?.text, 'Still want this?');
  assert.equal(f.sent[0]?.options.wake, false);
  const stale = { ...f.session, sessionId: f.session.sessionId + '-stale' };
  const path = join(f.root, `${stale.sessionId}.jsonl`);
  write(path, Date.now() - 8 * 24 * 60 * 60_000, 'toolu_stale', 'Too old?');
  claudeLogPathBySession.set(stale.sessionId, path);
  t.after(() => { claudeLogPathBySession.delete(stale.sessionId); });
  f.sent.length = 0;
  await publishClaudeOpenQuestions(f.client, [stale]);
  assert.equal(f.sent.length, 0, 'A question past the retention is never announced.');
});
