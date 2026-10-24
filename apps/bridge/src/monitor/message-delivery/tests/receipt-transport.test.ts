import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { RelayClient } from '../../../../../../packages/core/relay-client';
import { generateKeyPair, open } from '../../../../../../packages/core/crypto';
import { sendDeliveryReceipt } from '../../handlers/receipts';

test('a receipt reaches its original controller without depending on a separate session key grant', async t => {
  const machine = generateKeyPair(), requester = generateKeyPair(), passive = generateKeyPair();
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const frames: any[] = [];
  server.on('connection', socket => socket.on('message', bytes => frames.push(JSON.parse(String(bytes)))));
  const client = new RelayClient({ relayUrl: `ws://127.0.0.1:${address.port}`, room: 'receipt-test',
    role: 'machine', senderId: 'machine', deviceName: 'Fixture', myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey, peerPublicKey: requester.publicKey,
    peers: [{ publicKey: passive.publicKey }] } as never, { autoReconnect: false });
  t.after(async () => { client.close(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); });
  await client.connect();
  await sendDeliveryReceipt(client, 'original-message', 'rejected', 'Synthetic refusal',
    'native-grok-session', requester.publicKey);
  const limit = Date.now() + 3_000;
  while (Date.now() < limit && !frames.some(frame => frame.v === 1
    && (open(frame.nonce, frame.box, requester.publicKey, machine.secretKey) as any)?.type === 'delivery.receipt')) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const frame = frames.find(frame => frame.v === 1
    && (open(frame.nonce, frame.box, requester.publicKey, machine.secretKey) as any)?.type === 'delivery.receipt');
  assert.ok(frame, 'The error must be readable even if the task key grant was missed.');
  assert.equal(open(frame.nonce, frame.box, passive.publicKey, machine.secretKey), null);
  const receipt = open(frame.nonce, frame.box, requester.publicKey, machine.secretKey) as any;
  assert.equal(receipt.sessionId, 'native-grok-session');
  assert.equal(receipt.messageId, 'original-message');
  assert.equal(receipt.status, 'rejected');
});
