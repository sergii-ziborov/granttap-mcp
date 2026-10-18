import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { interruptCodexDesktop } from '..';
import { deliverToSession, prunePreparedAttachments } from '../../reply';
import { fixture, refuse, respond } from './fixture';

test('the native receipt survives a runtime process restart without replaying through the CLI', async t => {
  const f = await fixture(t);
  const messageId = randomUUID();
  const options = { messageId };
  assert.equal((await deliverToSession(f.session, 'Synthetic durable receipt', 2_000, [], options)).ok, true);
  const receipts = await readdir(join(f.root, 'config', 'codex-desktop-deliveries'));
  const stored = await readFile(join(f.root, 'config', 'codex-desktop-deliveries', receipts[0]!), 'utf8');
  assert.doesNotMatch(stored, /Synthetic durable receipt/);
  await rm(f.path);
  const module = new URL('../../reply/index.ts', import.meta.url).href;
  const script = `import {deliverToSession} from ${JSON.stringify(module)};` +
    `console.log(JSON.stringify(await deliverToSession(${JSON.stringify(f.session)},'Synthetic durable receipt',1000,[],${JSON.stringify(options)})));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { env: process.env, encoding: 'utf8', timeout: 5_000 }));
  assert.equal(result.ok, true);
  assert.equal(result.delivery, 'native');
  assert.equal(existsSync(f.marker), false);
});

test('an unreadable native receipt fails closed without starting either provider path', async t => {
  const f = await fixture(t);
  const options = { messageId: randomUUID() };
  await deliverToSession(f.session, 'Synthetic journal integrity', 2_000, [], options);
  const root = join(f.root, 'config', 'codex-desktop-deliveries');
  const [path] = await readdir(root);
  await writeFile(join(root, path!), 'not valid json');
  const before = f.requests.length;
  assert.equal((await deliverToSession(f.session, 'Synthetic journal integrity', 2_000, [], options)).ok, false);
  assert.equal(f.requests.length, before);
  assert.equal(existsSync(f.marker), false);
});

test('document staging expires after a day and ignores recent, unrelated and symlinked entries', async t => {
  const f = await fixture(t);
  const root = join(f.root, 'config', 'message-attachments');
  await mkdir(root, { recursive: true });
  assert.equal(prunePreparedAttachments(), 0);
  const old = join(root, 'granttap-attachments-Old');
  const recent = join(root, 'granttap-attachments-Recent');
  const other = join(root, 'unrelated');
  await Promise.all([mkdir(old), mkdir(recent), mkdir(other)]);
  const now = Date.now();
  await utimes(old, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000));
  await symlink(other, join(root, 'granttap-attachments-Alias'));
  assert.equal(prunePreparedAttachments(now), 1);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(other), true);
  assert.equal(existsSync(old), false);
});

test('native controls keep missing owners and errors separate from confirmed acknowledgement', async t => {
  const f = await fixture(t, (request, socket) => {
    if (request.params.conversationId === 'refused') refuse(socket, request, 'native refusal');
    else respond(socket, request, { ok: false });
  });
  assert.deepEqual(await interruptCodexDesktop('refused'), { ok: false });
  assert.deepEqual(await interruptCodexDesktop('unconfirmed'), { ok: false });
  await rm(f.path);
  assert.equal(await interruptCodexDesktop('missing'), undefined);
});
