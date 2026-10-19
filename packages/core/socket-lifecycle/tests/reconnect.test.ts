import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { generateKeyPair } from '../../crypto';
import { RelayClient } from '../../relay-client';
import { publicKeyIdentifier } from '../../ciphertext-recipient';

async function fixture(t: TestContext, rejectUpgrade = false) {
  let attempts = 0;
  let recipientKey: string | undefined;
  const http = createServer();
  const wss = new WebSocketServer({ server: http, verifyClient: rejectUpgrade
    ? (_info, done) => { attempts++; done(false, 429, 'Retry later', { 'Retry-After': '1' }); }
    : undefined });
  wss.on('connection', (socket, request) => {
    recipientKey = request.headers['x-granttap-recipient-key-id'] as string | undefined;
    attempts++;
    socket.once('message', () => socket.close(4425, 'cool-down; retry-after=1'));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const keys = generateKeyPair(), peer = generateKeyPair();
  const client = new RelayClient({ relayUrl: `ws://127.0.0.1:${address.port}`, room: 'retry-test',
    role: 'machine', deviceName: 'test computer', senderId: 'retry-test',
    myPublicKey: keys.publicKey, mySecretKey: keys.secretKey, peerPublicKey: peer.publicKey },
  { autoReconnect: true, minReconnectMs: 10, maxReconnectMs: 40 });
  t.after(async () => {
    client.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  return { client, attempts: () => attempts, recipientKey: () => recipientKey,
    expectedKey: publicKeyIdentifier(keys.publicKey) };
}

test('a policy close does not reopen a socket before relay retry-after', async t => {
  const f = await fixture(t);
  await f.client.connect();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(f.attempts(), 1, 'opening the handshake must not reset the server cool-down');
});

test('HTTP Retry-After also bounds manual reconnect attempts', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.client.connect());
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    await f.client.connect().catch(() => {});
  }
  assert.equal(f.attempts(), 1, 'foreground polling cannot bypass the relay retry window');
});

test('a transient machine declares its routing identity before it sends ciphertext', async t => {
  const f = await fixture(t);
  await f.client.connect();
  assert.equal(f.recipientKey(), f.expectedKey,
    'the relay must be able to reject a cooling machine before opening a socket and reading its frames');
});
