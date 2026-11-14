import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { RelayClient } from '../../relay-client';
import { generateKeyPair } from '../../crypto';
import { sendSessionPayload } from '../../../../apps/bridge/src/host/session-keys';

const settle = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
};

test('an unchanged chat head is broadcast once per connection; changes, replies and reconnects still go', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-unchanged-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = directory;
  const server = new WebSocketServer({ port: 0 }); await once(server, 'listening');
  const machine = generateKeyPair(), phone = generateKeyPair();
  let frames = 0, connections = 0;
  server.on('connection', socket => {
    connections += 1;
    socket.send(JSON.stringify({ type: 'relay.capabilities', recipientRouting: true, retainedState: true, retainedStateGroups: true }));
    socket.on('message', () => { frames += 1; });
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new RelayClient({ relayUrl: `ws://127.0.0.1:${address.port}`, room: 'fixture', role: 'machine',
    deviceName: 'Fixture', senderId: 'fixture', myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey });
  t.after(async () => {
    client.close(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect();
  await settle(() => client.supportsRetainedState === true && frames >= 1);
  const head = { type: 'session.activity' as const, sessionId: 'chat-0001', agent: 'codex' as const,
    state: 'idle' as const, entries: [], generatedAt: 1_700_000_000_000 };
  const sent = () => frames - 1; // the hello

  await sendSessionPayload(client, head, head.sessionId);
  await settle(() => sent() >= 2);
  assert.equal(sent(), 2, 'a key grant and the head');
  for (let i = 0; i < 5; i++) await sendSessionPayload(client, { ...head }, head.sessionId);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sent(), 2, 'the same head again sends nothing');

  await sendSessionPayload(client, { ...head, generatedAt: head.generatedAt + 1 }, head.sessionId);
  await settle(() => sent() >= 4);
  assert.equal(sent(), 4, 'a newer head goes at once');

  await sendSessionPayload(client, { ...head, generatedAt: head.generatedAt + 1 }, head.sessionId, 'phone',
    { peerPublicKey: phone.publicKey });
  await settle(() => sent() >= 6);
  assert.equal(sent(), 6, 'a reply to one phone is never skipped');

  client.close();
  await settle(() => !client.isConnected);
  await client.connect();
  await settle(() => connections === 2 && client.supportsRetainedState === true);
  assert.equal(connections, 2, 'the client reconnected');
  await new Promise(resolve => setTimeout(resolve, 30));
  const before = frames;
  await sendSessionPayload(client, { ...head, generatedAt: head.generatedAt + 1 }, head.sessionId);
  await settle(() => frames >= before + 2);
  assert.equal(frames - before, 2, 'a new connection hands the state over again');
});
