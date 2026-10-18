import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskDispatch } from '../index';

const now = Date.now();
const job = { type: 'task.dispatch', jobId: 'followup-job', token: 'a'.repeat(64),
  notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
  operation: { type: 'user.message.continue', messageId: 'followup-job', originMessageId: 'new-task-message',
    text: 'Synthetic follow-up', agent: 'codex', createdAt: now } };

test('a durable continuation names its original message without inventing a native session', () => {
  assert.deepEqual(TaskDispatch.parse(job), job);
  for (const change of [{ sessionId: 'fake-native' }, { cwd: '/other-project' },
    { requestId: 'approval' }, { originMessageId: '' }, { agent: undefined }, { messageId: undefined }]) {
    assert.equal(TaskDispatch.safeParse({ ...job, operation: { ...job.operation, ...change } }).success, false);
  }
  assert.equal(TaskDispatch.safeParse({ ...job, sessionId: 'fake-native' }).success, false);
  assert.equal(TaskDispatch.safeParse({ ...job, operation: {
    ...job.operation, originMessageId: job.operation.messageId,
  } }).success, false);
});
