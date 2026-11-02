import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateKeyPair } from '../../../../../../packages/core/crypto';
import { Payload, type TaskDispatch } from '../../../../../../packages/protocol/schema';
import { startTaskDispatchMonitor } from '../monitor';

test('a queued message reports its arrival once, while its chat keeps it waiting', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-arrival-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  let stop = () => {};
  t.after(() => {
    stop();
    if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const own = generateKeyPair(), peer = generateKeyPair();
  const config = { relayUrl: 'ws://127.0.0.1:1', room: 'arrival-fixture', role: 'machine' as const, deviceName: 'Fixture',
    senderId: 'fixture', myPublicKey: own.publicKey, mySecretKey: own.secretKey, peerPublicKey: peer.publicKey };
  let incoming!: (job: TaskDispatch, key: string) => void;
  const sent: Array<{ payload: unknown; peer?: string }> = [];
  const client = { room: config.room, isConnected: true, setSessionKey: () => {},
    onTaskDispatch: (callback: typeof incoming) => { incoming = callback; return () => {}; },
    send: async (payload: unknown, _to: string, options: { peerPublicKey?: string }) => {
      sent.push({ payload, peer: options.peerPublicKey });
    } };
  let claims = 0;
  stop = startTaskDispatchMonitor({ config, client: client as never, isLeader: () => true, peerAllowed: () => true,
    publish: async () => {}, remote: { get: async () => 'queued', claim: async () => { claims += 1; return true; }, finish: async () => {} },
    deliver: async () => 'accepted' });
  const now = Date.now();
  const job: TaskDispatch = { type: 'task.dispatch', jobId: 'arrival-job-01', token: 'a'.repeat(64), sessionId: 'arrival-chat',
    notBefore: now + 60_000, expiresAt: now + 120_000, createdAt: now,
    operation: { type: 'user.message', messageId: 'arrival-message-01', sessionId: 'arrival-chat', text: 'Synthetic task', createdAt: now } };
  incoming(job, peer.publicKey);
  incoming(job, peer.publicKey);
  await new Promise(next => setTimeout(next, 50));
  const arrivals = sent.filter(item => (item.payload as { type: string }).type === 'delivery.arrival');
  assert.equal(arrivals.length, 1, 'the relay repeats offers; the phone hears about the first');
  assert.equal(arrivals[0]?.peer, peer.publicKey);
  assert.equal(Payload.safeParse(arrivals[0]?.payload).success, true);
  assert.equal((arrivals[0]?.payload as { messageId: string }).messageId, 'arrival-message-01');
  assert.equal(claims, 0, 'arriving is not starting');
});
