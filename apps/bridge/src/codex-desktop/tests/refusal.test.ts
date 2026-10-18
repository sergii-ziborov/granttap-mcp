import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { deliverToSession } from '../../reply';
import { fixture, frame, refuse, respond } from './fixture';

test('a missing desktop socket and an explicit absent owner retain the headless path', async t => {
  const f = await fixture(t, undefined, { ownerFound: false });
  assert.deepEqual(await deliverToSession(f.session, 'Synthetic CLI continuation', 2_000),
    { ok: true, text: 'headless', sessionId: f.session.sessionId });
  assert.equal(existsSync(f.marker), true);
  await rm(f.marker);
  process.env.GRANTTAP_CODEX_DIR = join(f.root, 'no-desktop');
  assert.equal((await deliverToSession(f.session, 'Synthetic CLI continuation', 2_000)).ok, true);
  assert.equal(existsSync(f.marker), true);
});

test('a rejected native request never retries through a competing CLI or leaks native diagnostics', async t => {
  const f = await fixture(t, (request, socket) => refuse(socket, request, 'Private provider diagnostic'));
  const result = await deliverToSession(f.session, 'Synthetic rejected follow-up', 2_000);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /not confirmed/);
  assert.doesNotMatch(JSON.stringify(result), /Private provider/);
  assert.equal(existsSync(f.marker), false);
});

test('a disconnected dispatch is not replayed after reconnect or after the desktop closes', async t => {
  const f = await fixture(t, (_request, socket) => socket.destroy());
  const options = { messageId: randomUUID() };
  assert.equal((await deliverToSession(f.session, 'Synthetic uncertain follow-up', 2_000, [], options)).ok, false);
  assert.equal((await deliverToSession(f.session, 'Synthetic uncertain follow-up', 2_000, [], options)).ok, false);
  await rm(f.path);
  assert.equal((await deliverToSession(f.session, 'Synthetic uncertain follow-up', 2_000, [], options)).ok, false);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
  assert.equal(existsSync(f.marker), false);
});

test('a confirmed delivery remains confirmed after its desktop owner disappears', async t => {
  const f = await fixture(t);
  const options = { messageId: randomUUID() };
  assert.equal((await deliverToSession(f.session, 'Synthetic confirmed follow-up', 2_000, [], options)).ok, true);
  await rm(f.path);
  const repeated = await deliverToSession(f.session, 'Synthetic confirmed follow-up', 2_000, [], options);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.ok && repeated.text, '');
  assert.equal(existsSync(f.marker), false);
});

test('a reused message ID cannot substitute a different intent', async t => {
  const f = await fixture(t);
  const options = { messageId: randomUUID() };
  await deliverToSession(f.session, 'Synthetic original intent', 2_000, [], options);
  const changed = await deliverToSession(f.session, 'Synthetic changed intent', 2_000, [], options);
  assert.equal(changed.ok, false);
  assert.match(changed.ok ? '' : changed.error, /different Codex delivery/);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});

test('a native acceptance handles fragmented frames, broadcasts, and client discovery without gaining ownership', async t => {
  const f = await fixture(t, (request, socket) => {
    if (request.type !== 'request') return;
    const frames = Buffer.concat([
      frame({ type: 'client-discovery-request', requestId: 'other-discovery' }),
      frame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: 'unrelated' } }),
      frame({ type: 'request', requestId: 'unhandled-request', method: 'unexpected' }),
      frame({ type: 'response', requestId: request.requestId, method: request.method, handledByClientId: 'native-owner',
        resultType: 'success', result: { result: { turn: { id: 'fragmented-turn' } } } }),
    ]);
    socket.write(frames.subarray(0, 2));
    setImmediate(() => socket.write(frames.subarray(2, 13)));
    setImmediate(() => socket.write(frames.subarray(13)));
  });
  assert.equal((await deliverToSession(f.session, 'Synthetic fragmented receipt', 2_000)).ok, true);
  assert.equal(existsSync(f.marker), false);
});

test('an oversized, malformed or incorrectly routed native reply fails closed', async t => {
  const f = await fixture(t, (request, socket) => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(9 * 1024 * 1024);
    if (request.params.turnStart.request.input[0].text === 'Oversized') socket.write(oversized);
    else if (request.params.turnStart.request.input[0].text === 'Malformed') socket.write(Buffer.from([1, 0, 0, 0, 123]));
    else socket.write(frame({ type: 'response', requestId: request.requestId, method: request.method,
      resultType: 'success', handledByClientId: 'wrong-owner', result: { result: { turn: { id: 'wrong' } } } }));
  });
  for (const text of ['Oversized', 'Malformed', 'Wrong owner']) {
    assert.equal((await deliverToSession(f.session, text, 2_000)).ok, false);
  }
  assert.equal(existsSync(f.marker), false);
});

test('an unresponsive owner has a bounded deadline and never starts a CLI', async t => {
  const f = await fixture(t, () => {});
  const started = Date.now();
  assert.equal((await deliverToSession(f.session, 'Synthetic unconfirmed receipt', 30)).ok, false);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(existsSync(f.marker), false);
});

test('a writable directory, public socket, or symlink cannot receive the controller input', async t => {
  const f = await fixture(t);
  for (const path of [f.home, join(f.home, 'ipc'), f.path]) {
    await chmod(path, 0o777);
    assert.equal((await deliverToSession(f.session, 'Synthetic private input', 2_000)).ok, false);
    await chmod(path, path === f.path ? 0o600 : 0o700);
  }
  const alias = join(f.root, 'alias');
  await symlink(f.home, alias);
  process.env.GRANTTAP_CODEX_DIR = alias;
  assert.equal((await deliverToSession(f.session, 'Synthetic private input', 2_000)).ok, false);
  assert.equal(f.requests.length, 0);
  assert.equal(existsSync(f.marker), false);
});

test('Task sandbox and disabled MCP policy are enforced without changing native approval policy', async t => {
  const f = await fixture(t, (request, socket) => respond(socket, request, { result: { turn: { id: randomUUID() } } }));
  await mkdir(join(f.root, 'config'), { recursive: true });
  for (const access of ['read-only', 'workspace', 'full']) {
    await writeFile(join(f.root, 'config', 'config.json'), JSON.stringify({ sessionAccess: { [f.session.sessionId]: access } }));
    assert.equal((await deliverToSession(f.session, 'Synthetic policy check', 2_000)).ok, true);
    const sent = f.requests.at(-1)?.params.turnStart.request;
    assert.equal(sent.approvalPolicy, undefined);
    assert.equal(sent.sandboxPolicy.type, { 'read-only': 'readOnly', workspace: 'workspaceWrite', full: 'dangerFullAccess' }[access]);
  }
  await writeFile(join(f.root, 'config', 'config.json'), JSON.stringify({ sessionMcpDisabled: { [f.session.sessionId]: ['fixture'] } }));
  assert.equal((await deliverToSession(f.session, 'Synthetic denied MCP', 2_000)).ok, false);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 3);
  assert.equal(existsSync(f.marker), false);
});
