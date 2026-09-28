import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { EngineFrameDecoder, encodeEngineFrame } from '../../../../../bridge/src/engine/protocol/engine-protocol';
import { DesktopNativeAccess } from '../access';
import { installDesktopNativeRoutes } from '../routes';

test('native HTTP bridge rejects browser forgery and unauthenticated reads, then relays scoped local operations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-routes-'));
  const socketPath = join(root, 'desktop.sock');
  let requests = 0;
  const socket = createServer(client => {
    const decoder = new EngineFrameDecoder();
    client.on('data', bytes => {
      const row = decoder.push(bytes)[0];
      if (!row) return;
      requests++;
      client.end(encodeEngineFrame({ protocol_version: 1, request_id: row.request_id,
        status: 'ok', result: { operation: row.operation, input: row.input } }));
    });
  });
  await new Promise<void>(resolve => socket.listen(socketPath, resolve));
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  installDesktopNativeRoutes(app, socketPath, origin, new DesktopNativeAccess(join(root, 'grants.json')));
  try {
    const verifier = 'aa'.repeat(32);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorization = await fetch(`${origin}/desktop/authorize?challenge=${challenge}&state=state123`);
    const html = await authorization.text();
    const hidden = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!;
    const cookie = authorization.headers.get('set-cookie')!.split(';')[0]!;
    const body = new URLSearchParams({ id: hidden('id'), confirmation: hidden('confirmation'), state: hidden('state') });
    const approve = (site: string) => fetch(`${origin}/desktop/approve`, { method: 'POST', redirect: 'manual',
      headers: { origin: site, cookie }, body });
    assert.equal((await approve('https://evil.test')).status, 403);
    const approved = await approve(origin);
    const callback = new URL(approved.headers.get('location')!);
    assert.equal(callback.protocol, 'granttap:');
    const response = await fetch(`${origin}/desktop/token`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: callback.searchParams.get('code'), verifier }) });
    assert.equal(response.status, 200);
    const { access_token } = await response.json() as { access_token: string };
    const invoke = (token: string, operation = 'desktop.workspace') => fetch(`${origin}/desktop/invoke`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, input: { limit: '1' } }),
    });
    assert.equal((await invoke('wrong')).status, 401);
    assert.equal((await invoke(access_token, 'provider.secret')).status, 400);
    assert.equal(requests, 0);
    assert.deepEqual(await (await invoke(access_token)).json(), { operation: 'desktop.workspace', input: { limit: '1' } });
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await new Promise<void>(resolve => socket.close(() => resolve()));
  }
});
