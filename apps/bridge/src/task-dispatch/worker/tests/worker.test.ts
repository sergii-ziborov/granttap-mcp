import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { generateKeyPair } from '../../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../../packages/protocol/schema';
import { TaskDispatchInbox } from '../../index';
import { TaskDispatchWorker, type WorkerOptions } from '../index';
import { taskDispatchReady } from '../readiness';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-job-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inbox = new TaskDispatchInbox(root, 'fixture-room'), peer = generateKeyPair().publicKey;
  const now = Date.now();
  const job: TaskDispatch = { type: 'task.dispatch', jobId: 'worker-job-01', token: 'a'.repeat(64),
    sessionId: 'chat', notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
    operation: { type: 'user.message', sessionId: 'chat', messageId: 'message-01', text: 'Synthetic task', createdAt: now } };
  inbox.stage(job, peer);
  let state = 'queued', starts = 0, claims = 0, busy = false, finishFails = false;
  const options: WorkerOptions = { inbox, connected: () => true, authorized: () => true, ready: () => !busy,
    remote: { get: async () => state, claim: async () => { claims++; state = 'accepted'; return true; },
      finish: async (_job: TaskDispatch, outcome: string) => {
        if (finishFails) throw new Error('Synthetic outage'); state = outcome;
      } },
    deliver: async (_job: TaskDispatch, beforeStart: () => Promise<void>) => {
      await beforeStart(); starts++; return 'accepted' as const;
    } };
  return { inbox, job, options, starts: () => starts, claims: () => claims,
    state: () => state, setState: (value: string) => { state = value; },
    busy: (value: boolean) => { busy = value; }, finishFails: (value: boolean) => { finishFails = value; } };
}

test('relay queue waits while busy and starts once after readiness, without any phone connection', async t => {
  const f = fixture(t), worker = new TaskDispatchWorker(f.options);
  f.busy(true); await worker.tick(); assert.equal(f.claims(), 0);
  f.busy(false); await worker.tick(); await worker.tick();
  assert.equal(f.starts(), 1); assert.equal(f.state(), 'completed');
  assert.equal(f.inbox.status(f.job.jobId)?.phase, 'completed');
});

test('explicit Send now releases the selected job ahead of older waiting follow-ups', async t => {
  const f = fixture(t), immediate = { ...f.job, jobId: 'worker-send-now', createdAt: f.job.createdAt + 1,
    deliveryMode: 'immediate' as const };
  f.inbox.stage(immediate, generateKeyPair().publicKey);
  f.options.ready = job => taskDispatchReady(job, { inFlight: false, paused: false,
    generatedAt: Date.now(), session: { sessionId: 'chat', agent: 'claude', state: 'working',
      startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 } });
  const delivered: string[] = [];
  f.options.remote.get = async () => 'queued';
  f.options.deliver = async (job, beforeStart) => { await beforeStart(); delivered.push(job.jobId); return 'accepted'; };
  await new TaskDispatchWorker(f.options).tick();
  assert.deepEqual(delivered, [immediate.jobId]);
  assert.equal(f.inbox.status(f.job.jobId)?.phase, 'staged');
});

test('a cancelled server job never starts from a stale local offer', async t => {
  const f = fixture(t); f.setState('cancelled');
  await new TaskDispatchWorker(f.options).tick();
  assert.equal(f.starts(), 0); assert.equal(f.inbox.status(f.job.jobId)?.phase, 'cancelled');
});

test('completion is retried independently of native execution after a relay outage and restart', async t => {
  const f = fixture(t); f.finishFails(true);
  await new TaskDispatchWorker(f.options).tick();
  assert.equal(f.inbox.records()[0]?.phase, 'delivered'); assert.equal(f.starts(), 1);
  f.finishFails(false); await new TaskDispatchWorker(f.options).tick();
  assert.equal(f.state(), 'completed'); assert.equal(f.starts(), 1);
});

test('an interrupted native invocation needs confirmation and never runs a second time', async t => {
  const f = fixture(t); f.setState('accepted');
  f.inbox.transition(f.job.jobId, 'claimed');
  f.inbox.transition(f.job.jobId, 'running', { nativeAttemptId: 'original-attempt' });
  const worker = new TaskDispatchWorker(f.options); await worker.tick(); await worker.tick();
  assert.equal(f.starts(), 0); assert.equal(f.inbox.records()[0]?.phase, 'rejected');
  assert.equal(f.inbox.records()[0]?.code, 'confirmation_required');
  assert.equal(f.state(), 'failed');
});

test('competing workers cannot submit the same persisted native attempt twice', async t => {
  const f = fixture(t);
  await Promise.all([new TaskDispatchWorker(f.options).tick(), new TaskDispatchWorker(f.options).tick()]);
  assert.equal(f.starts(), 1);
});

 test('a completion transport failure must not turn a successful native run into failed work', async t => {
  const f = fixture(t); let calls = 0;
  const finish = f.options.remote.finish;
  f.options.remote.finish = async (job, state) => {
    calls++; if (calls === 1) throw new Error('Synthetic lost completion response');
    assert.equal(state, 'completed'); await finish(job, state);
  };
  const worker = new TaskDispatchWorker(f.options); await worker.tick(); await worker.tick();
  assert.equal(f.starts(), 1); assert.equal(f.state(), 'completed');
});

test('a failed queued message holds later follow-ups until the failure is cancelled', async t => {
  const f = fixture(t), next = structuredClone(f.job);
  next.jobId = 'worker-job-02'; next.createdAt++;
  f.inbox.stage(next, generateKeyPair().publicKey);
  f.options.deliver = async (_job, beforeStart) => { await beforeStart(); return 'rejected'; };
  const worker = new TaskDispatchWorker(f.options); await worker.tick(); await worker.tick();
  assert.equal(f.claims(), 1);
  assert.equal(f.inbox.get(next.jobId).phase, 'staged');
});
