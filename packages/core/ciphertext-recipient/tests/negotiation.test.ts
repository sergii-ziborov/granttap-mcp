import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { generateKeyPair } from '../../crypto';
import { RelayClient } from '../../relay-client';

for (const supported of [true, false]) {
  test(`encrypted recipient routing negotiates support=${supported}`, async t => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const machine = generateKeyPair();
    const phone = generateKeyPair();
    const frames: Record<string, unknown>[] = [];
    wss.on('connection', socket => {
      socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
      if (supported) {
        socket.send(JSON.stringify({ type: 'relay.capabilities', recipientRouting: true }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${address.port}`, room: 'fixture', role: 'machine',
      deviceName: 'fixture', senderId: 'fixture', myPublicKey: machine.publicKey,
      mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey,
    });
    t.after(async () => {
      client.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      wss.close();
    });
    await client.connect();
    await new Promise(resolve => setTimeout(resolve, 30));
    await client.send({ type: 'machine.heartbeat', machine: 'fixture', createdAt: Date.now() }, 'phone');
    await new Promise(resolve => setTimeout(resolve, 30));
    const sent = frames.find(frame => frame.to === 'phone');
    assert.ok(sent);
    const expected = createHash('sha256').update(Buffer.from(phone.publicKey, 'base64')).digest('hex');
    assert.equal(sent.recipientKeyId, supported ? expected : undefined);
  });
}
