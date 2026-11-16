import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { generateKeyPair } from '../../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../../packages/protocol/schema';
import { TaskDispatchInbox } from '../../index';
import { TaskDispatchWorker, type WorkerOptions } from '../index';
import { conversationKeyOf, queuedPhoneMessages } from '../queue-depth';

const phone = generateKeyPair().publicKey;
let sequence = 0;

function message(chat: string | undefined, extra: Partial<TaskDispatch> = {}, text = 'Synthetic follow-up'): TaskDispatch {
  const now = Date.now(), id = `queue-depth-${++sequence}`.padEnd(12, '0');
  return { type: 'task.dispatch', jobId: id, token: 'b'.repeat(64), sessionId: chat, notBefore: now,
    expiresAt: now + 86_400_000, createdAt: now + sequence,
    operation: { type: 'user.message', sessionId: chat, messageId: `${id}-message`, text, createdAt: now }, ...extra };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-queue-depth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inbox = new TaskDispatchInbox(root, 'queue-depth-room');
  const relay = new Map<string, string>(), counts = new Map<string, number>();
  const options: WorkerOptions = { inbox, connected: () => true, authorized: () => true, ready: () => true,
    conversationKey: conversationKeyOf(job => job.operation.type === 'user.message.continue' ? undefined : job),
    remote: { get: async job => relay.get(job.jobId) ?? 'queued',
      claim: async job => { relay.set(job.jobId, 'accepted'); return true; },
      finish: async (job, outcome) => { relay.set(job.jobId, outcome); } },
    deliver: async (job, beforeStart, _peer, queued) => {
      await beforeStart(); counts.set(job.jobId, queued()); return 'accepted';
    } };
  return { root, inbox, options, counts, worker: new TaskDispatchWorker(options) };
}

test('a delivery counts the phone messages queued behind it for its own chat only', async t => {
  const f = fixture(t), [first, second, third, other] = [message('chat-a'), message('chat-a'), message('chat-a'), message('chat-b')];
  for (const job of [first, second, third, other]) f.inbox.stage(job, phone);
  f.inbox.stage(message('chat-a', { origin: 'computer' }), phone);
  await f.worker.tick();
  assert.equal(f.counts.get(first.jobId), 2, 'two more for chat-a; chat-b and the computer\'s own job are not counted');
  assert.equal(f.counts.get(other.jobId), 0, 'the only message of chat-b has nothing behind it');
  await f.worker.tick(); await f.worker.tick();
  assert.deepEqual([f.counts.get(second.jobId), f.counts.get(third.jobId)], [1, 0], 'each next one sees what is left');
});

test('an empty queue and a chat whose follow-ups wait behind a refusal count nothing', async t => {
  const f = fixture(t), refused = message('chat-c'), held = message('chat-c'), alone = message('chat-d');
  f.inbox.stage(refused, phone); f.inbox.stage(held, phone);
  f.inbox.transition(refused.jobId, 'failed', { code: 'policy_denied' }); f.inbox.transition(refused.jobId, 'rejected');
  f.inbox.stage(alone, phone);
  await f.worker.tick();
  assert.equal(f.counts.get(alone.jobId), 0);
  assert.equal(f.counts.has(held.jobId), false, 'held behind the refusal, it is not delivered either');
  await new Promise(resolve => setTimeout(resolve, 5));
  const sent = message('chat-c');
  f.inbox.stage(sent, phone);
  assert.equal(queuedPhoneMessages('chat-c', 'queue-depth-room', f.root), 1,
    'a message the person sent after seeing the refusal is the only one counted');
});

test('a new task counts the follow-ups written for it before its chat existed', async t => {
  const f = fixture(t), created = message(undefined);
  if (created.operation.type === 'user.message') created.operation.taskOriginId = 'origin-of-new-task';
  const followUp = (origin: string): TaskDispatch => {
    const job = message(undefined);
    return { ...job, operation: { type: 'user.message.continue', agent: 'claude', messageId: `${job.jobId}-message`,
      originMessageId: origin, text: 'Also check the docs', createdAt: job.createdAt } };
  };
  f.inbox.stage(created, phone);
  for (const job of [followUp('origin-of-new-task'), followUp('origin-of-new-task'), followUp('another-task')]) {
    f.inbox.stage(job, phone);
  }
  f.inbox.stage(message(undefined), phone);
  f.options.ready = job => job.jobId === created.jobId;
  await f.worker.tick();
  assert.equal(f.counts.get(created.jobId), 2, 'another new task and another task\'s follow-up are other chats');
});

test('another process reads the count for a chat without creating anything', async t => {
  const f = fixture(t), empty = mkdtempSync(join(tmpdir(), 'granttap-queue-depth-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.equal(queuedPhoneMessages('chat-e', 'queue-depth-room', empty), 0);
  assert.deepEqual(readdirSync(empty), []);
  for (const job of [message('chat-e'), message('chat-e'), message('chat-f')]) f.inbox.stage(job, phone);
  const before = readdirSync(f.root, { recursive: true }).sort();
  assert.equal(queuedPhoneMessages('chat-e', 'queue-depth-room', f.root), 2);
  assert.equal(queuedPhoneMessages('chat-e', 'another-room', f.root), 0);
  assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), before);
});
