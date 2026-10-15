import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { generateKeyPair } from '../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../packages/protocol/schema';
import { TaskDispatchInbox } from '../inbox';

function job(): TaskDispatch {
  const now = Date.now();
  return { type: 'task.dispatch', jobId: 'durable-inbox-1', token: 'a'.repeat(64),
    notBefore: now, expiresAt: now + 86_400_000, createdAt: now, sessionId: 'chat',
    operation: { type: 'user.message', messageId: 'message-1', sessionId: 'chat',
      text: 'Continue this synthetic task', attachments: [{ name: 'photo.jpg', mimeType: 'image/jpeg',
        data: Buffer.from('synthetic picture').toString('base64') }], createdAt: now } };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-inbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const room = 'b'.repeat(32), peer = generateKeyPair().publicKey;
  return { root, room, peer, inbox: new TaskDispatchInbox(root, room) };
}

test('durable receiver admission preserves text, images and peer identity across restart', t => {
  const f = fixture(t), request = job();
  assert.equal(f.inbox.stage(request, f.peer), 'staged');
  const recovered = new TaskDispatchInbox(f.root, f.room);
  assert.equal(recovered.records().length, 1);
  assert.deepEqual(recovered.records()[0]?.job, request);
  assert.equal(recovered.records()[0]?.phase, 'staged');
});

test('duplicate offers cannot change a staged operation or reset its execution state', t => {
  const f = fixture(t), request = job();
  f.inbox.stage(request, f.peer);
  assert.equal(f.inbox.transition(request.jobId, 'claimed'), true);
  assert.equal(f.inbox.transition(request.jobId, 'running', { nativeAttemptId: 'attempt-1' }), true);
  assert.equal(f.inbox.transition(request.jobId, 'running', { nativeAttemptId: 'attempt-2' }), false);
  assert.equal(f.inbox.stage(request, f.peer), 'existing');
  const changed = structuredClone(request); changed.operation.text = 'Different request';
  assert.equal(f.inbox.stage(changed, f.peer), 'conflict');
  const recovered = new TaskDispatchInbox(f.root, f.room);
  assert.equal(recovered.records()[0]?.nativeAttemptId, 'attempt-1');
});

test('a partial final journal write cannot erase a durable running record', t => {
  const f = fixture(t), request = job();
  f.inbox.stage(request, f.peer);
  f.inbox.transition(request.jobId, 'claimed');
  f.inbox.transition(request.jobId, 'running', { nativeAttemptId: 'attempt-1' });
  const journal = readdirSync(f.root, { recursive: true, encoding: 'utf8' }).find(name => name.endsWith('.jsonl'));
  assert.ok(journal);
  appendFileSync(join(f.root, journal), '{"partial":');
  const recovered = new TaskDispatchInbox(f.root, f.room);
  assert.equal(recovered.records()[0]?.phase, 'running');
  assert.equal(recovered.transition(request.jobId, 'uncertain'), true);
  assert.equal(new TaskDispatchInbox(f.root, f.room).records()[0]?.phase, 'uncertain');
  assert.equal(recovered.transition(request.jobId, 'running'), false, 'An uncertain native invocation must never retry blindly.');
});

test('confirmed terminal jobs retain only a replay receipt while active work keeps its complete payload', t => {
  const f = fixture(t), request = job();
  f.inbox.stage(request, f.peer);
  assert.equal(f.inbox.retire(request.jobId), false);
  f.inbox.reserveClaim(request.jobId);
  f.inbox.transition(request.jobId, 'claimed');
  f.inbox.transition(request.jobId, 'running', { nativeAttemptId: 'synthetic-attempt' });
  f.inbox.transition(request.jobId, 'delivered');
  f.inbox.transition(request.jobId, 'completed');
  assert.equal(f.inbox.retire(request.jobId), true);
  const restored = new TaskDispatchInbox(f.root, f.room);
  assert.equal(restored.status(request.jobId)?.phase, 'completed');
  assert.equal(restored.pendingRecords().length, 0);
  assert.equal(restored.stage(request, f.peer), 'existing');
  assert.equal(restored.stage({ ...request, operation: { ...request.operation, text: 'Changed request' } }, f.peer), 'conflict');
  assert.equal(readdirSync(f.root, { recursive: true, encoding: 'utf8' }).some(name => name.endsWith('request.json')), false);
});
