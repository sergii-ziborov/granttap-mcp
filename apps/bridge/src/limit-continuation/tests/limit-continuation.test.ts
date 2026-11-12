import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {SessionInfo, UserMessage} from '../../../../../packages/protocol/schema';
import {
  annotateLimitContinuations, LIMIT_CONTINUE_GRACE_MS, limitContinuationUnwanted, scheduleLimitContinuations,
  setAutoContinue, type ContinuationQueue,
} from '..';

const now = 1_800_000_000_000;
function isolated(t: {after: (fn: () => void) => void}): void {
  const root = mkdtempSync(join(tmpdir(), 'granttap-limit-continuation-')), prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, {recursive: true, force: true}); });
}
function queue(): ContinuationQueue & {submitted: {message: UserMessage; notBefore: number}[]; cancelled: string[]} {
  const submitted: {message: UserMessage; notBefore: number}[] = [], cancelled: string[] = [];
  return {submitted, cancelled,
    submit: async (_scope, message, notBefore) => { submitted.push({message, notBefore}); },
    cancel: async (_scope, id) => { cancelled.push(id); }};
}
const chat = (resetsAt?: number, extra: Partial<SessionInfo> = {}): SessionInfo => ({sessionId: 'limited-chat', agent: 'claude',
  cwd: '/work/app', state: 'idle', startedAt: now - 3_600_000, lastActivityAt: now - 60_000, tokensSession: 0, tokensLastTurn: 0,
  ...(resetsAt ? {usageLimit: {resetsAt, window: 'five_hour'}} : {}), ...extra});

test('a chat stopped by its limit is continued once from the relay when the limit resets, unless turned off', async t => {
  isolated(t);
  const relay = queue(), resetsAt = now + 2 * 3_600_000;
  assert.equal(annotateLimitContinuations([chat(resetsAt)])[0]?.usageLimit?.autoContinue, true, 'on by default');
  await scheduleLimitContinuations([chat(resetsAt)], relay, now);
  await scheduleLimitContinuations([chat(resetsAt)], relay, now + 1_000);
  assert.equal(relay.submitted.length, 1, 'one continuation for one limit, however often the catalog is published');
  const [queued] = relay.submitted;
  assert.equal(queued?.notBefore, resetsAt + LIMIT_CONTINUE_GRACE_MS);
  assert.equal(queued?.message.sessionId, 'limited-chat');
  assert.equal(queued?.message.cwd, '/work/app');
  assert.match(queued?.message.text ?? '', /limit .*reset/i);
  assert.equal(limitContinuationUnwanted(queued!.message), false, 'it is delivered when it comes back');

  setAutoContinue('limited-chat', false);
  assert.equal(annotateLimitContinuations([chat(resetsAt)])[0]?.usageLimit?.autoContinue, false);
  await scheduleLimitContinuations([chat(resetsAt)], relay, now + 2_000);
  assert.deepEqual(relay.cancelled, [queued!.message.messageId], 'turning it off takes it back from the relay');
  assert.equal(relay.submitted.length, 1);
  assert.equal(limitContinuationUnwanted(queued!.message), true, 'a copy the relay still had is not delivered');

  setAutoContinue('limited-chat', true);
  await scheduleLimitContinuations([chat(resetsAt)], relay, now + 3_000);
  assert.equal(relay.submitted.length, 2, 'turning it back on queues it again');
});

test('a chat that went on by itself has its queued continuation taken back', async t => {
  isolated(t);
  const relay = queue(), resetsAt = now + 3_600_000;
  await scheduleLimitContinuations([chat(resetsAt)], relay, now);
  await scheduleLimitContinuations([chat(undefined, {state: 'working'})], relay, now + 5_000);
  assert.deepEqual(relay.cancelled, [relay.submitted[0]!.message.messageId]);
  await scheduleLimitContinuations([chat(undefined)], relay, now + 6_000);
  assert.equal(relay.cancelled.length, 1, 'and forgotten');
});

test('old limits, other agents and chats not stopped by a limit are left alone', async t => {
  isolated(t);
  const relay = queue();
  await scheduleLimitContinuations([
    chat(now - 2 * 3_600_000),
    chat(now + 3_600_000, {sessionId: 'codex-chat', agent: 'codex'}),
    chat(now + 3_600_000, {sessionId: 'busy-chat', state: 'working'}),
    chat(undefined, {sessionId: 'plain-chat'}),
  ], relay, now);
  assert.equal(relay.submitted.length, 0, 'a chat abandoned at a limit hours ago is not woken by an update');
  const message = {type: 'user.message', messageId: 'phone-message', sessionId: 'plain-chat', text: 'x', createdAt: now} as UserMessage;
  assert.equal(limitContinuationUnwanted(message), false, 'ordinary messages are never held back');
});
