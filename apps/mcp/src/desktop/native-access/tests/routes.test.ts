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
    assert.match(html, /<link rel="stylesheet" href="\/desktop\/consent\.css">/);
    assert.match(html, /<main class="consent-card">/);
    assert.match(html, /Allow this Mac app/);
    const russian = await fetch(`${origin}/desktop/authorize?challenge=${challenge}&state=state456`, {
      headers: { 'accept-language': 'ru-RU,ru;q=0.9' },
    });
    assert.match(await russian.text(), /lang="ru"[\s\S]*Разрешить на этом Mac/);
    assert.match(authorization.headers.get('content-security-policy') ?? '', /style-src 'self'/);
    assert.doesNotMatch(authorization.headers.get('content-security-policy') ?? '', /unsafe-inline/);
    const stylesheet = await fetch(`${origin}/desktop/consent.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') ?? '', /text\/css/);
    assert.match(await stylesheet.text(), /consent-card/);
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
    assert.equal((await fetch(`${origin}/desktop/account/link`, { method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ accountToken: 'a'.repeat(43) }),
    })).status, 401);
    assert.equal((await invoke(access_token, 'provider.secret')).status, 400);
    assert.equal(requests, 0);
    assert.deepEqual(await (await invoke(access_token)).json(), { operation: 'desktop.workspace', input: { limit: '1' } });
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await new Promise<void>(resolve => socket.close(() => resolve()));
  }
});

test('a verified passkey account grants the Mac app local access without browser consent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-account-'));
  const app = express();
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const access = new DesktopNativeAccess(join(root, 'grants.json'));
  const accountToken = 'a'.repeat(43);
  let verified = 0;
  installDesktopNativeRoutes(app, join(root, 'desktop.sock'), origin, access, async token => {
    verified++;
    if (token !== accountToken) throw new Error('Account mismatch');
    return { accountId: 'f25c3ec0-e0a3-4fbd-bf2b-e7cc4571e49b',
      machineId: '65086bbc-3d07-4674-ac70-0360de97bc61' };
  });
  try {
    const authorize = (token: string) => fetch(`${origin}/desktop/account/authorize`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountToken: token }),
    });
    assert.equal((await authorize('wrong')).status, 403);
    const approved = await authorize(accountToken);
    assert.equal(approved.status, 200);
    const result = await approved.json() as { access_token: string };
    assert.equal(access.verify(result.access_token), true);
    assert.equal(verified, 2);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});

test('native consent accepts an opaque browser Origin only with its one-time local cookie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-opaque-'));
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  installDesktopNativeRoutes(app, join(root, 'desktop.sock'), origin,
    new DesktopNativeAccess(join(root, 'grants.json')));
  try {
    const challenge = createHash('sha256').update('bb'.repeat(32)).digest('base64url');
    const page = await fetch(`${origin}/desktop/authorize?challenge=${challenge}&state=opaque123`);
    const html = await page.text();
    const hidden = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!;
    const body = new URLSearchParams({ id: hidden('id'), confirmation: hidden('confirmation'), state: hidden('state') });
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const submit = (cookieValue: string) => fetch(`${origin}/desktop/approve`, {
      method: 'POST', redirect: 'manual', headers: { origin: 'null', cookie: cookieValue }, body,
    });
    assert.equal((await submit('')).status, 403);
    assert.equal((await submit(cookie)).status, 302);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
