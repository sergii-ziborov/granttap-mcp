import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
const keyPair = () => { const pair = nacl.box.keyPair(); return { publicKey: Buffer.from(pair.publicKey).toString('base64'), secretKey: Buffer.from(pair.secretKey).toString('base64') }; };
import { sealEnvelope } from '../../relay-envelope';
import { retainedPayloadOptions } from '../index';
const machine = keyPair(), phone = keyPair();
const cfg = { role: 'machine' as const, relayUrl: 'ws://localhost', room: 'a'.repeat(32),
  deviceName: 'Fixture', senderId: 'fixture', myPublicKey: machine.publicKey,
  mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey };
const payload = { type: 'sessions.status' as const, machine: 'Fixture', sessions: [], generatedAt: Date.now() };

test('only a negotiated recipient gets opaque retained snapshot metadata', () => {
  const options = retainedPayloadOptions(payload);
  assert.match(options.stateKey!, /^[a-f0-9]{64}$/);
  const legacy = JSON.parse(sealEnvelope(cfg, payload, 'phone', { ...options, retainedState: false }));
  assert.equal(legacy.stateKey, undefined);
  const saved = JSON.parse(sealEnvelope(cfg, payload, 'phone', { ...options, retainedState: true }));
  assert.equal(saved.stateKey, options.stateKey);
  assert.equal(saved.deliveryId, undefined);
  assert.equal(saved.stateRevision, payload.generatedAt);
  assert.match(saved.recipientKeyId, /^[a-f0-9]{64}$/);
  assert.ok(saved.expiresAt > Date.now() + 6 * 86400000);
});

test('task keys precede task heads; history pages and commands never replace a head', () => {
  assert.equal(retainedPayloadOptions({ type: 'session.key.grant', sessionId: 'task', key: 'secret', createdAt: Date.now() }).statePriority, 0);
  const activity = { type: 'session.activity' as const, sessionId: 'task', agent: 'codex' as const, state: 'idle' as const, entries: [], generatedAt: Date.now() };
  assert.ok(retainedPayloadOptions(activity).stateKey);
  assert.equal(retainedPayloadOptions({ ...activity, history: { requestedCursor: 'older', hasMore: true } } as never).stateKey, undefined);
  assert.equal(retainedPayloadOptions({ type: 'hello', role: 'machine', deviceName: 'Fixture', createdAt: Date.now() }).stateKey, undefined);
});
