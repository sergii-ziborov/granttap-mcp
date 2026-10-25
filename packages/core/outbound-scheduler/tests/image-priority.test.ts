import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { RelayClient } from '../../relay-client';
import { generateKeyPair, generateTransferKey, open, openWithTransferKey } from '../../crypto';

test('an encrypted requested image reaches the phone before background transcript backfill', async t => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const machine = generateKeyPair(), phone = generateKeyPair(), taskKey = generateTransferKey();
  const config = { relayUrl: `ws://127.0.0.1:${address.port}`, room: 'image-priority-fixture',
    role: 'machine' as const, deviceName: 'Fixture', senderId: 'fixture',
    myPublicKey: machine.publicKey, mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey };
  const frames: any[] = [];
  server.on('connection', socket => socket.on('message', raw => frames.push(JSON.parse(raw.toString()))));
  const client = new RelayClient(config);
  t.after(async () => { client.close(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); });
  await client.connect();
  while (frames.length < 1) await new Promise(resolve => setTimeout(resolve, 5));
  frames.length = 0;
  client.setSessionKey('image-priority-task', taskKey);
  const snapshots = Array.from({ length: 24 }, (_, n) => client.sendSession({ type: 'session.activity',
    sessionId: 'image-priority-task', agent: 'codex', state: 'idle', entries: [], generatedAt: n },
  'image-priority-task', 'phone', { peerPublicKey: phone.publicKey, reliable: false }));
  const picture = client.sendSession({ type: 'session.image.chunk', sessionId: 'image-priority-task',
    requestId: 'visible-image', imageId: 'fixture-image', offset: 0, mimeType: 'image/png',
    totalBytes: 3, dataBase64: Buffer.from('png').toString('base64') },
  'image-priority-task', 'phone', { peerPublicKey: phone.publicKey, reliable: false, ttlMs: 20_000 });
  await Promise.all([...snapshots, picture]);
  const deadline = Date.now() + 5_000;
  while (frames.length < 25 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(frames.length, 25);
  const payloads = frames.map(frame => {
    assert.equal(frame.urgent, undefined, 'Queue priority must not become cleartext routing metadata');
    assert.equal(frame.wake, undefined, 'Reading a photo must not send a push notification');
    const sealed = open(frame.nonce, frame.box, machine.publicKey, phone.secretKey) as any;
    assert.equal(sealed.type, 'session.sealed');
    return openWithTransferKey(sealed.nonce, sealed.box, taskKey) as any;
  });
  assert.ok(payloads.findIndex(value => value.type === 'session.image.chunk') <= 1,
    'A visible photo cannot wait behind the transcript backfill that its preview triggered');
  assert.equal(payloads.filter(value => value.type === 'session.activity').length, 24);
});
