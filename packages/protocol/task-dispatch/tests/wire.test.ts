import assert from 'node:assert/strict';
import test from 'node:test';
import { Payload } from '../../schema';

function dispatch() {
  return { type: 'task.dispatch', jobId: 'queued-message-1', token: 'a'.repeat(64),
    notBefore: 1_000_000, expiresAt: 2_000_000, createdAt: 1_000_000,
    sessionId: 'existing-chat', operation: { type: 'user.message', messageId: 'message-1',
      sessionId: 'existing-chat', text: 'Continue the synthetic test task', createdAt: 1_000_000 } };
}

test('durable task envelope preserves signed scheduling and correlated native message identity', () => {
  const value = dispatch();
  const parsed = Payload.safeParse(value);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data, value);
});

test('explicit Send now is authenticated inside the immutable job', () => {
  const value = { ...dispatch(), deliveryMode: 'immediate' };
  const parsed = Payload.safeParse(value);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data, value);
  assert.equal(Payload.safeParse({ ...value, deliveryMode: 'ignore_policy' }).success, false);
});

test('scheduled dispatch cannot carry stale attachment references or an approval reply', () => {
  const reference = dispatch();
  Object.assign(reference.operation, { attachmentRefs: [{ attachmentId: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg' }] });
  assert.equal(Payload.safeParse(reference).success, false);
  const approval = dispatch(); Object.assign(approval.operation, { requestId: 'approval-request' });
  assert.equal(Payload.safeParse(approval).success, false);
});

test('durable dispatch refuses mismatched sessions, missing operation IDs and configuration changes', () => {
  const mismatched = dispatch(); mismatched.sessionId = 'different-chat';
  assert.equal(Payload.safeParse(mismatched).success, false);
  const unidentified = dispatch(); delete (unidentified.operation as Partial<typeof unidentified.operation>).messageId;
  assert.equal(Payload.safeParse(unidentified).success, false);
  assert.equal(Payload.safeParse({ ...dispatch(), operation: { type: 'config.set', gatingEnabled: false } }).success, false);
});

test('scheduled jobs require bounded clock ordering and an authenticated receiver token', () => {
  const invalidClock = dispatch(); invalidClock.expiresAt = invalidClock.notBefore;
  assert.equal(Payload.safeParse(invalidClock).success, false);
  const invalidToken = dispatch(); invalidToken.token = 'not-a-token';
  assert.equal(Payload.safeParse(invalidToken).success, false);
});

test('photo-only queued messages retain their inline bytes without requiring a caption', () => {
  const value = dispatch(); value.operation.text = '';
  Object.assign(value.operation, { attachments: [{ name: 'photo.png', mimeType: 'image/png', data: 'AQID' }] });
  assert.equal(Payload.safeParse(value).success, true);
});
