import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionInfo, TaskDispatch } from '../../../../../../packages/protocol/schema';
import { taskDispatchReady } from '../readiness';

const now = 1_000_000;
const job: TaskDispatch = { type: 'task.dispatch', jobId: 'ready-job-01', token: 'a'.repeat(64),
  sessionId: 'chat', notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
  operation: { type: 'user.message', sessionId: 'chat', messageId: 'message-01', text: 'Synthetic task', createdAt: now } };
const session: SessionInfo = { sessionId: 'chat', agent: 'claude', state: 'working',
  startedAt: now, lastActivityAt: now, tokensSession: 0, tokensLastTurn: 0 };
const observation = { session, generatedAt: now, inFlight: false, paused: false };

test('Send now can release working Claude while normal queued work waits', () => {
  assert.equal(taskDispatchReady(job, observation, now), false);
  assert.equal(taskDispatchReady({ ...job, deliveryMode: 'immediate' }, observation, now), true);
});

test('Send now preserves pause and in-flight protection', () => {
  const immediate = { ...job, deliveryMode: 'immediate' as const };
  assert.equal(taskDispatchReady(immediate, { ...observation, paused: true }, now), false);
  assert.equal(taskDispatchReady(immediate, { ...observation, inFlight: true }, now), false);
});

test('automatic queue release requires a fresh idle catalog rather than another full native scan', () => {
  const idle = { ...observation, session: { ...session, state: 'idle' as const } };
  assert.equal(taskDispatchReady(job, idle, now), true);
  assert.equal(taskDispatchReady(job, { ...idle, generatedAt: now - 120_000 }, now), false);
  assert.equal(taskDispatchReady(job, { ...idle, generatedAt: undefined }, now), false);
  assert.equal(taskDispatchReady(job, { ...idle, generatedAt: now + 120_000 }, now), false);
  assert.equal(taskDispatchReady(job, { ...idle, session: undefined }, now), true);
  assert.equal(taskDispatchReady({ ...job, sessionId: undefined }, observation, now), true);
});
