import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateKeyPair } from '../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../packages/protocol/schema';
import { startTaskDispatchMonitor } from '../../task-dispatch/worker/monitor';
import { TaskOriginRegistry } from '../index';
import { ORPHAN_GRACE_MS, ORPHAN_LOOKUP_MS, ORPHAN_REASON, OrphanFollowUps } from '../orphans';

const settle = () => new Promise(next => setTimeout(next, 20));

function followUp(now: number, id = 'follow-up-01'): TaskDispatch {
  return { type: 'task.dispatch', jobId: id, token: 'a'.repeat(64), deliveryMode: 'immediate',
    notBefore: now, expiresAt: now + 30 * 86_400_000, createdAt: now,
    operation: { type: 'user.message.continue', messageId: id, originMessageId: 'lost-task-01',
      text: 'Synthetic follow-up', createdAt: now, agent: 'claude' } };
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-orphans-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = 1_800_000_000_000;
  const asked: string[] = [], errors: unknown[] = [];
  const relay = { state: 'expired' as string, fail: false };
  const registry = new TaskOriginRegistry(join(root, 'origins'), { now: () => clock });
  const orphans = new OrphanFollowUps({ registry, now: () => clock, onError: error => errors.push(error),
    relayState: async id => {
      asked.push(id);
      if (relay.fail) throw new Error('relay down');
      return relay.state;
    } });
  const scope = { room: 'orphan-room', peerPublicKey: 'phone-key' };
  return { registry, orphans, scope, asked, errors, relay,
    advance: (ms: number) => { clock += ms; }, get now() { return clock; } };
}

test('a follow-up waits while its new task can still come, and is refused once it cannot', async t => {
  const f = fixture(t);
  const stagedAt = f.now, job = followUp(f.now);
  assert.equal(f.orphans.orphaned(job, f.scope, stagedAt), false);
  assert.deepEqual(f.asked, [], 'nothing is asked inside the grace period');

  f.advance(ORPHAN_GRACE_MS);
  f.relay.state = 'queued';
  assert.equal(f.orphans.orphaned(job, f.scope, stagedAt), false, 'the answer arrives on a later pass');
  await settle();
  assert.deepEqual(f.asked, ['lost-task-01'], 'the relay is asked about the task, not the follow-up');
  assert.equal(f.orphans.orphaned(job, f.scope, stagedAt), false, 'a task still queued on the relay can come');
  assert.equal(f.asked.length, 1, 'the relay is not asked again before the lookup interval');

  f.advance(ORPHAN_LOOKUP_MS);
  f.relay.state = 'expired';
  f.orphans.orphaned(job, f.scope, stagedAt);
  await settle();
  assert.equal(f.orphans.orphaned(job, f.scope, stagedAt), true);
  assert.equal(f.asked.length, 2);
});

test('a creation on record answers for its follow-ups, even after the relay said the task was gone', async t => {
  const f = fixture(t);
  const stagedAt = f.now, job = followUp(f.now);
  f.advance(ORPHAN_GRACE_MS + 1);
  f.orphans.orphaned(job, f.scope, stagedAt);
  await settle();
  assert.equal(f.orphans.orphaned(job, f.scope, stagedAt), true);
  f.registry.begin({ ...f.scope, originMessageId: 'lost-task-01' }, { type: 'user.message', messageId: 'lost-task-01',
    taskOriginId: 'lost-task-01', text: 'Synthetic task', createdAt: f.now, agent: 'claude' });
  assert.equal(f.orphans.orphaned(job, f.scope, stagedAt), false, 'a creation still running keeps its follow-up waiting');
});

test('a relay error keeps the follow-up waiting and is asked again later', async t => {
  const f = fixture(t);
  const stagedAt = f.now, job = followUp(f.now);
  f.advance(ORPHAN_GRACE_MS);
  f.relay.fail = true;
  f.orphans.orphaned(job, f.scope, stagedAt);
  await settle();
  assert.equal(f.orphans.orphaned(job, f.scope, stagedAt), false);
  assert.equal(f.errors.length, 1);
  f.relay.fail = false;
  f.advance(ORPHAN_LOOKUP_MS);
  f.orphans.orphaned(job, f.scope, stagedAt);
  await settle();
  assert.equal(f.orphans.orphaned(job, f.scope, stagedAt), true);
});

test('only a follow-up written before its chat existed can be an orphan', t => {
  const f = fixture(t);
  const now = f.now;
  const message: TaskDispatch = { type: 'task.dispatch', jobId: 'chat-message-01', token: 'a'.repeat(64),
    sessionId: 'chat', notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
    operation: { type: 'user.message', messageId: 'chat-message-01', sessionId: 'chat', text: 'Synthetic', createdAt: now } };
  f.advance(ORPHAN_GRACE_MS * 10);
  assert.equal(f.orphans.orphaned(message, f.scope, now), false);
  assert.deepEqual(f.asked, []);
});

test('the monitor tells the phone a follow-up arrived, then refuses it with the reason once its task is gone',
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'granttap-orphan-monitor-'));
    const prior = process.env.GRANTTAP_CONFIG_DIR;
    process.env.GRANTTAP_CONFIG_DIR = root;
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    let stop = () => {};
    t.after(() => {
      stop();
      if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    });
    const own = generateKeyPair(), peer = generateKeyPair();
    const config = { relayUrl: 'ws://127.0.0.1:1', room: 'orphan-fixture', role: 'machine' as const,
      deviceName: 'Fixture', senderId: 'fixture', myPublicKey: own.publicKey, mySecretKey: own.secretKey,
      peerPublicKey: peer.publicKey };
    let incoming!: (job: TaskDispatch, key: string) => void;
    const sent: Array<{ payload: Record<string, unknown>; peer?: string }> = [];
    const client = { room: config.room, isConnected: true, setSessionKey: () => {},
      onTaskDispatch: (callback: typeof incoming) => { incoming = callback; return () => {}; },
      send: async (payload: Record<string, unknown>, _to: string, options: { peerPublicKey?: string }) => {
        sent.push({ payload, peer: options.peerPublicKey });
      } };
    const asked: string[] = [], finished: Array<{ state: string; code?: string }> = [];
    let delivered = 0;
    stop = startTaskDispatchMonitor({ config, client: client as never, isLeader: () => true, peerAllowed: () => true,
      publish: async () => {},
      remote: { get: async job => { asked.push(job.jobId); return job.jobId === 'lost-task-01' ? 'expired' : 'queued'; },
        claim: async () => true, finish: async (_job, state, code) => { finished.push({ state, code }); } },
      deliver: async () => { delivered += 1; return 'accepted'; } });
    const job = followUp(Date.now()), second = followUp(Date.now() + 1, 'follow-up-02');
    incoming(job, peer.publicKey);
    incoming(second, peer.publicKey);
    await settle();
    const arrival = sent.find(item => item.payload.type === 'delivery.arrival');
    assert.equal(arrival?.payload.messageId, 'follow-up-01', 'the phone hears that the follow-up is here');
    assert.equal(arrival?.payload.sessionId, undefined);
    assert.equal(arrival?.peer, peer.publicKey);

    t.mock.timers.tick(ORPHAN_GRACE_MS);
    incoming(job, peer.publicKey);
    await settle();
    assert.ok(asked.includes('lost-task-01'), 'the relay is asked about the task the follow-up was written for');
    assert.deepEqual([...finished], [], 'the answer is read on the next pass');
    incoming(job, peer.publicKey);
    await settle();
    assert.deepEqual([...finished], [{ state: 'failed', code: 'delivery_failed' }]);
    // The second follow-up was written for the same lost task: it is refused too, not held behind the first.
    incoming(job, peer.publicKey);
    await settle();
    assert.deepEqual(finished.map(item => item.code), ['delivery_failed', 'delivery_failed']);
    incoming(job, peer.publicKey);
    await settle();
    assert.equal(finished.length, 2, 'a refused follow-up is not refused twice');
    const refusals = sent.filter(item => item.payload.type === 'delivery.receipt');
    assert.deepEqual(refusals.map(item => item.payload.messageId), ['follow-up-01', 'follow-up-02']);
    for (const refusal of refusals) {
      assert.equal(refusal.payload.status, 'rejected');
      assert.equal(refusal.payload.error, ORPHAN_REASON);
      assert.equal(refusal.peer, peer.publicKey);
    }
    assert.equal(sent.filter(item => item.payload.type === 'delivery.arrival').length, 2);
    assert.equal(delivered, 0, 'a follow-up without its task never starts a chat of its own');
  });
