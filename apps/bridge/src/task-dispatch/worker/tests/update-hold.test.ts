import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { generateKeyPair } from '../../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../../packages/protocol/schema';
import { runtimeWorkTracker } from '../../../runtime-updates/readiness';
import { TaskDispatchInbox } from '../../index';
import { startTaskDispatchMonitor } from '../monitor';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-update-hold-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const own = generateKeyPair(), peer = generateKeyPair();
  const config = { relayUrl: 'ws://127.0.0.1:1', room: 'update-hold-fixture', role: 'machine' as const, deviceName: 'Fixture',
    senderId: 'fixture', myPublicKey: own.publicKey, mySecretKey: own.secretKey, peerPublicKey: peer.publicKey };
  let incoming!: (job: TaskDispatch, key: string) => void;
  const client = { room: config.room, isConnected: true, setSessionKey: () => {}, send: async () => {},
    onTaskDispatch: (callback: typeof incoming) => { incoming = callback; return () => {}; } };
  const state = { held: true, claims: 0, relay: new Map<string, string>(), delivered: [] as string[] };
  let finishHandler = () => {};
  const handler = new Promise<void>(resolve => { finishHandler = resolve; });
  const work = runtimeWorkTracker(() => false);
  const stop = startTaskDispatchMonitor({ config, client: client as never, isLeader: () => true, peerAllowed: () => true,
    publish: async () => {}, held: () => state.held, track: work.run,
    remote: { get: async job => state.relay.get(job.jobId) ?? 'queued',
      claim: async job => { state.claims++; state.relay.set(job.jobId, 'accepted'); return true; },
      finish: async (job, outcome) => { state.relay.set(job.jobId, outcome); } },
    deliver: async (job, beforeStart) => { await beforeStart(); state.delivered.push(job.jobId); await handler; return 'accepted'; } });
  t.after(() => {
    stop(); finishHandler();
    if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now();
  const job: TaskDispatch = { type: 'task.dispatch', jobId: 'update-hold-job-01', token: 'a'.repeat(64),
    notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
    operation: { type: 'user.message', messageId: 'update-hold-message-01', text: 'Synthetic task', createdAt: now } };
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 30_000;
    while (!predicate() && Date.now() < deadline) await new Promise(next => setTimeout(next, 10));
    assert.ok(predicate());
  };
  return { state, job, work, until, finishHandler, offer: () => incoming(job, peer.publicKey),
    inbox: () => new TaskDispatchInbox(join(root, 'task-dispatch'), config.room) };
}

test('a message that arrives while an update drains the monitor is kept, and runs once when the hold ends', async t => {
  const f = fixture(t);
  f.offer();
  await new Promise(next => setTimeout(next, 150));
  assert.equal(f.state.claims, 0, 'nothing is claimed from the relay, so the new runtime can still take it');
  assert.deepEqual(f.state.delivered, []);
  assert.equal(f.inbox().status(f.job.jobId)?.phase, 'staged', 'the message stays on this computer, not refused');
  assert.equal(f.work.idle(), true, 'a waiting message is not work in flight');
  f.state.held = false;
  f.offer();
  await f.until(() => f.state.delivered.length === 1);
  assert.equal(f.work.idle(), false, 'a delivery is monitor work until its handler has returned');
  f.finishHandler();
  await f.until(() => f.state.relay.get(f.job.jobId) === 'completed');
  await f.until(() => f.work.idle());
  f.offer();
  await new Promise(next => setTimeout(next, 100));
  assert.deepEqual(f.state.delivered, [f.job.jobId], 'the message ran exactly once');
  assert.equal(f.state.claims, 1);
});
