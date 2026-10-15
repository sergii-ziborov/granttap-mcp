import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayClient, type PeerConfig } from '../../relay-client';
import { generateKeyPair, seal } from '../../crypto';
import { publicKeyIdentifier } from '../../ciphertext-recipient';

function fixture() {
  const machine = generateKeyPair(), phone = generateKeyPair();
  const cfg: PeerConfig = { relayUrl: 'ws://127.0.0.1:1', room: 'a'.repeat(32), role: 'machine',
    senderId: 'machine', deviceName: 'Computer', myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey };
  const seen: unknown[] = [], ordinary: unknown[] = [];
  const client = new RelayClient(cfg, { onTaskDispatch: (job: unknown) => { seen.push(job); } });
  client.onMessage(payload => { ordinary.push(payload); return true; });
  const now = Date.now();
  const dispatch = { type: 'task.dispatch', jobId: 'scheduled-message-1', token: 'b'.repeat(64),
    sessionId: 'native-chat', notBefore: now - 1000, expiresAt: now + 60_000, createdAt: now - 1000,
    operation: { type: 'user.message', sessionId: 'native-chat', messageId: 'message-1',
      text: 'Continue the synthetic test task', createdAt: now - 1000 } };
  const envelope = { v: 1, room: cfg.room, from: 'phone', to: 'machine', senderId: 'phone',
    deliveryId: dispatch.jobId, recipientKeyId: publicKeyIdentifier(machine.publicKey),
    expiresAt: dispatch.expiresAt, ...seal(dispatch, machine.publicKey, phone.secretKey) };
  const offer = { type: 'relay.task-job', job: { id: dispatch.jobId, state: 'queued',
    notBefore: dispatch.notBefore, expiresAt: dispatch.expiresAt, envelope } };
  const receive = (value: unknown) => (client as unknown as { onRaw(raw: string): Promise<void> }).onRaw(JSON.stringify(value));
  return { client, cfg, dispatch, offer, seen, ordinary, receive };
}

test('authenticated relay jobs reach only the durable consumer with signed schedule intact', async () => {
  const f = fixture();
  await f.receive(f.offer);
  assert.deepEqual(f.seen, [f.dispatch]);
  assert.deepEqual(f.ordinary, []);
});

test('tampered routing, identity and scheduling cannot turn a relay offer into a different job', async () => {
  const f = fixture();
  const wrongId = structuredClone(f.offer); wrongId.job.id = 'different-message';
  const wrongTime = structuredClone(f.offer); wrongTime.job.notBefore++;
  const wrongExpiry = structuredClone(f.offer); wrongExpiry.job.expiresAt++;
  const wrongTarget = structuredClone(f.offer); wrongTarget.job.envelope.recipientKeyId = 'f'.repeat(64);
  for (const bad of [wrongId, wrongTime, wrongExpiry, wrongTarget]) await f.receive(bad);
  assert.deepEqual(f.seen, []);
  await f.receive(f.offer);
  assert.equal(f.seen.length, 1);
});

test('ordinary encrypted delivery cannot bypass durable scheduling or receiver admission', async () => {
  const f = fixture();
  await f.receive(f.offer.job.envelope);
  assert.deepEqual(f.seen, []);
  assert.deepEqual(f.ordinary, []);
});

test('same-computer queued work uses a dedicated authenticated lane, never ordinary peer authority', async () => {
  const f = fixture();
  const local = { ...f.dispatch, origin: 'computer' };
  const envelope = { ...f.offer.job.envelope,
    ...seal(local, f.cfg.myPublicKey, f.cfg.mySecretKey) };
  await f.receive({ ...f.offer, job: { ...f.offer.job, envelope } });
  assert.equal(f.seen.length, 1);
  await f.receive(envelope);
  assert.equal(f.seen.length, 1);
  assert.deepEqual(f.ordinary, []);
});

test('a paired controller cannot claim the same-computer origin in an encrypted job', async () => {
  const f = fixture();
  // The original controller-signed box is valid but its origin cannot be upgraded by the relay.
  const selfMarked = { ...f.dispatch, origin: 'computer' };
  const phone = generateKeyPair();
  const cfg = { ...f.cfg, peerPublicKey: phone.publicKey };
  const client = new RelayClient(cfg, { onTaskDispatch: job => { f.seen.push(job); } });
  const envelope = { ...f.offer.job.envelope, ...seal(selfMarked, cfg.myPublicKey, phone.secretKey) };
  await (client as unknown as { onRaw(raw: string): Promise<void> }).onRaw(JSON.stringify({
    ...f.offer, job: { ...f.offer.job, envelope } }));
  assert.equal(f.seen.length, 0);
});
