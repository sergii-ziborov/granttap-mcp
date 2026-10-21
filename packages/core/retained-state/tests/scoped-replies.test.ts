import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { RelayClient } from '../../relay-client';
import { generateKeyPair, open } from '../../crypto';
import { sendSessionPayload } from '../../../../apps/bridge/src/host/session-keys';

test('historical replies cannot fill relay cache with orphan grants; current heads retain their group', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-scoped-cache-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = directory;
  const server = new WebSocketServer({ port: 0 }); await once(server, 'listening');
  const machine = generateKeyPair(), phone = generateKeyPair(), frames: Record<string, unknown>[] = [];
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'relay.capabilities', recipientRouting: true, retainedState: true, retainedStateGroups: true }));
    socket.on('message', raw => { const env = JSON.parse(raw.toString());
      const payload = open(env.nonce, env.box, machine.publicKey, phone.secretKey) as { type?: string };
      if (payload?.type !== 'hello') frames.push(env);
    });
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
  for (let i = 0; i < 100 && !client.supportsRetainedState; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const payload = { type: 'session.activity' as const, sessionId: 'fixture-task', agent: 'codex' as const,
    state: 'idle' as const, entries: [], generatedAt: Date.now() };
  await sendSessionPayload(client, { ...payload, history: { requestedCursor: 'older-page', hasMore: false } }, payload.sessionId);
  await sendSessionPayload(client, payload, payload.sessionId);
  for (let i = 0; i < 100 && frames.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(frames.length, 4);
  assert.equal(frames[0]!.stateKey, undefined);
  assert.equal(frames[1]!.stateKey, undefined);
  assert.ok(frames[2]!.stateKey);
  assert.equal(frames[2]!.stateGroup, frames[3]!.stateGroup);
});
