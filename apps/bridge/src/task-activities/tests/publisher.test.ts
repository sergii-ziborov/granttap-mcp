import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskActivityPublisher } from '../publisher';
import { activityHTTP } from '../transport';
import { generateKeyPair, seal, generateTransferKey, openWithTransferKey } from '../../../../../packages/core/crypto';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import type { SessionsStatus } from '../../../../../packages/protocol/schema';

function fixture() {
  const machine = generateKeyPair(), phone = generateKeyPair(), key = generateTransferKey();
  let now = 1_000_000, leader = true, allowed = true;
  const config: PeerConfig = {role: 'machine', room: 'qa-room', relayUrl: 'wss://relay.example', pushAuth: 'synthetic-auth',
    deviceName: 'QA', senderId: 'qa', myPublicKey: machine.publicKey, mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey};
  const enrollment = {version: 1, kind: 'task.activity.subscription', room: config.room, activityId: 'activity',
    keyId: 'opaque', key, expiresAt: now + 600_000, previews: true};
  const record = {activityId: 'activity', expiresAt: enrollment.expiresAt,
    ...seal(enrollment, machine.publicKey, phone.secretKey)};
  const catalog: SessionsStatus = {type: 'sessions.status', machine: 'QA Mac', generatedAt: now, sessions: [{
    sessionId: 'qa-task', agent: 'codex', state: 'working', title: 'Sample task', summary: 'Sample answer',
    startedAt: now, lastActivityAt: now, tokensSession: 0, tokensLastTurn: 0}]};
  return {config, key, record, catalog, options: {config, catalog: () => catalog,
    isLeader: () => leader, peerAllowed: () => allowed, now: () => now},
    advance: (ms: number) => { now += ms; catalog.generatedAt = now; },
    revoke: () => {allowed = false;}, demote: () => {leader = false;}};
}

test('publisher encrypts root previews, coalesces unchanged state and ends an empty catalog', async () => {
  const f = fixture(), sent: any[] = [];
  const publisher = new TaskActivityPublisher({...f.options, http: async (path, body) => {
    if (path === 'subscriptions') return {subscriptions: [f.record]};
    sent.push(body); return {accepted: true};
  }});
  await Promise.all([publisher.tick(), publisher.tick()]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'update');
  assert.equal(sent[0].staleDate, 1090);
  assert.ok(!JSON.stringify(sent[0]).includes('Sample'));
  assert.equal((openWithTransferKey(sent[0].contentState.nonce, sent[0].contentState.box, f.key) as any).taskCount, 1);
  f.advance(15_000); await publisher.tick(); assert.equal(sent.length, 1);
  f.advance(45_000); await publisher.tick(); assert.equal(sent.length, 2);
  f.advance(15_000); f.catalog.sessions = []; await publisher.tick();
  assert.equal(sent.at(-1).event, 'end');
  publisher.close(); f.advance(60_000); await publisher.tick(); assert.equal(sent.length, 3);
});

test('no publication for stale catalog, revoked phone, absent leader, or failed transport', async () => {
  const f = fixture(); let updates = 0, fail = true;
  const publisher = new TaskActivityPublisher({...f.options, http: async (path) => {
    if (path === 'subscriptions') return {subscriptions: [f.record]};
    updates++; if (fail) throw Error('synthetic failure'); return {accepted: true, closed: true};
  }});
  await publisher.tick(); fail = false; await publisher.tick(); assert.equal(updates, 2);
  f.revoke(); f.advance(60_000); await publisher.tick(); assert.equal(updates, 2);
  f.catalog.generatedAt -= 100_000; await publisher.tick(); assert.equal(updates, 2);
  f.demote(); f.advance(60_000); await publisher.tick(); assert.equal(updates, 2);
});

test('HTTP converts paired relay URL, sends bounded ciphertext and refuses oversized responses', async () => {
  const f = fixture(); const calls: {url: string; options: RequestInit}[] = [];
  const http = activityHTTP(f.config, async (url, options) => {
    calls.push({url: String(url), options: options!});
    return new Response(JSON.stringify({subscriptions: []}));
  });
  assert.deepEqual(await http('subscriptions'), {subscriptions: []});
  assert.equal(calls[0]!.url, 'https://relay.example/push/activity/subscriptions?room=qa-room');
  assert.equal(calls[0]!.options.redirect, 'error');
  await http('update', {contentState: {nonce: 'fake', box: 'fake'}});
  assert.equal(calls[1]!.options.method, 'POST');
  assert.equal(await activityHTTP(f.config, async () => new Response('x'.repeat(24_001)))('subscriptions'), null);
  assert.equal(await activityHTTP(f.config, async () => new Response('', {status: 503}))('subscriptions'), null);
  assert.equal(await activityHTTP({...f.config, pushAuth: undefined})('subscriptions'), null);
});
