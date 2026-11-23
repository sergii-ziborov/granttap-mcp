import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionsStatus, type SessionInfo, type TaskDispatch } from '../../../../../packages/protocol/schema';
import { annotateQueueHolds, limitCanHold, queueHeldByLimit, RETRY_AFTER_REFUSAL_MS } from '..';

const minute = 60_000, hour = 60 * minute, NOW = Date.UTC(2026, 10, 23, 10, 0), RESET = NOW + 3 * hour;
const limited = (extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: 'catalog-chat-01', agent: 'claude',
  state: 'idle', startedAt: NOW - 5 * hour, lastActivityAt: NOW - minute, tokensSession: 0, tokensLastTurn: 0,
  usageLimit: { resetsAt: RESET, window: 'five_hour', autoContinue: false }, ...extra });
const noReadings = () => [];

function isolated(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'granttap-limit-catalog-')), prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true }); });
  return root;
}

function logged(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  });
  return lines;
}

test('the catalog says until when a limited chat holds its queue, and the wire keeps it', t => {
  isolated(t);
  const free: SessionInfo = { ...limited(), sessionId: 'free-chat-0001', usageLimit: undefined };
  const sessions = annotateQueueHolds([limited(), free], NOW, noReadings);
  assert.deepEqual(sessions[0]?.queueHold, { reason: 'usage_limit', until: RESET });
  assert.equal(sessions[1], free, 'a chat without a limit is untouched');
  const unchanged = [free];
  assert.equal(annotateQueueHolds(unchanged, NOW, noReadings), unchanged);
  const wire = SessionsStatus.parse({ type: 'sessions.status', machine: 'fixture', sessions, generatedAt: NOW });
  assert.deepEqual(wire.sessions[0]?.queueHold, { reason: 'usage_limit', until: RESET });
  assert.equal(annotateQueueHolds([limited()], RESET + 2 * minute, noReadings)[0]?.queueHold, undefined,
    'after the reset nothing holds a chat that does not continue itself');
  const { usageLimit: _limit, ...rest } = limited();
  const codex: SessionInfo = { ...rest, agent: 'codex', stopped: { reason: 'usage_limit', at: NOW - minute } };
  assert.deepEqual(annotateQueueHolds([codex], NOW, noReadings)[0]?.queueHold,
    { reason: 'usage_limit', until: NOW - minute + RETRY_AFTER_REFUSAL_MS }, 'no stated reset: the next try');
});

test('what the queue tried is read by the catalog: a chat refused again says when it tries next', t => {
  isolated(t);
  const lines = logged(t);
  assert.equal(queueHeldByLimit('catalog-chat-01', limited(), NOW, noReadings), true);
  assert.equal(queueHeldByLimit('catalog-chat-01', limited(), RESET + 2 * minute, noReadings), false, 'the reset lets one go');
  const refusedAt = RESET + 3 * minute, again = limited({ lastActivityAt: refusedAt });
  assert.deepEqual(annotateQueueHolds([again], refusedAt + minute, noReadings)[0]?.queueHold,
    { reason: 'usage_limit', until: refusedAt + RETRY_AFTER_REFUSAL_MS });
  assert.equal(queueHeldByLimit('catalog-chat-01', again, refusedAt + minute, noReadings), true);
  assert.equal(queueHeldByLimit('catalog-chat-01', { ...again, usageLimit: undefined, state: 'idle' }, refusedAt + hour,
    noReadings), false, 'the chat went on');
  assert.equal(queueHeldByLimit('catalog-chat-01', limited({ lastActivityAt: refusedAt + 2 * hour }), refusedAt + 2 * hour,
    noReadings), false, 'forgotten once it went on: a later refusal for a past reset is a first one');
  assert.equal(lines.length, 5, lines.join('\n'));
  assert.match(lines[2]!, new RegExp('wait for its 5-hour limit \\(reset 2026-11-23 13:00 UTC\\): '
    + 'the chat was refused again; the next one goes at 2026-11-23 13:18 UTC\\.$'));
  assert.match(lines[3]!, /go on: the chat went on without the limit\.$/);
  assert.equal(queueHeldByLimit('catalog-chat-01', undefined, NOW, noReadings), false, 'an unknown chat is not held');
});

test('a hold store the disk cannot read is logged once and the queue still waits for the limit', t => {
  const root = isolated(t);
  mkdirSync(join(root, 'limit-queue-hold.json'));
  const lines = logged(t);
  assert.equal(queueHeldByLimit('catalog-chat-01', limited(), NOW, noReadings), true);
  assert.equal(queueHeldByLimit('catalog-chat-01', limited(), NOW + minute, noReadings), true);
  assert.equal(lines.filter(line => line.includes('could not be read or saved')).length, 1, lines.join('\n'));
  assert.equal(annotateQueueHolds([limited()], NOW, () => { throw new Error('unreadable'); })[0]?.queueHold?.until, RESET);
});

test('only a queued phone message to an existing chat waits; Send now, new tasks and continuations go', () => {
  const job = (extra: Partial<TaskDispatch>, messageId = 'phone-message-01'): TaskDispatch => ({ type: 'task.dispatch',
    jobId: 'catalog-job-01', token: 'a'.repeat(64), sessionId: 'catalog-chat-01', notBefore: NOW, expiresAt: NOW + hour,
    createdAt: NOW, operation: { type: 'user.message', sessionId: 'catalog-chat-01', messageId, text: 'Next', createdAt: NOW },
    ...extra });
  assert.equal(limitCanHold(job({})), true);
  assert.equal(limitCanHold(job({ deliveryMode: 'immediate' })), false);
  assert.equal(limitCanHold(job({ origin: 'computer' }, 'limit-continue-0123456789abcdef')), false);
  assert.equal(limitCanHold(job({ sessionId: undefined, operation: { type: 'user.message', messageId: 'new-task-01', text: 'New',
    createdAt: NOW } })), false);
});
