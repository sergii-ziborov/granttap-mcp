import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TaskOriginRegistry } from '../index';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-origins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { room: 'room', peerPublicKey: 'controller', originMessageId: 'origin-message' };
  const message = { type: 'user.message' as const, messageId: scope.originMessageId,
    agent: 'codex' as const, projectId: 'project', cwd: '/synthetic/project',
    text: 'Private synthetic prompt', createdAt: 100 };
  return { root, scope, message, registry: new TaskOriginRegistry(root) };
}

test('a native origin is reserved once and the durable session survives receiver restart', t => {
  const f = fixture(t);
  assert.equal(f.registry.lookup(f.scope, 'codex').state, 'waiting');
  assert.equal(f.registry.begin(f.scope, f.message).state, 'started');
  assert.equal(new TaskOriginRegistry(f.root).begin(f.scope, f.message).state, 'waiting');
  f.registry.complete(f.scope, { ok: true, sessionId: 'native-chat' });
  assert.deepEqual(new TaskOriginRegistry(f.root).lookup(f.scope, 'codex'),
    { state: 'ready', sessionId: 'native-chat', projectId: 'project' });
  assert.equal(f.registry.begin(f.scope, f.message).state, 'ready');
  f.registry.complete(f.scope, { ok: true, sessionId: 'another-chat' });
  assert.equal(f.registry.lookup(f.scope, 'codex').sessionId, 'native-chat');
  const files = readdirSync(f.root).filter(name => name.endsWith('.json'));
  assert.ok(files.length);
  assert.ok(files.every(name => !readFileSync(join(f.root, name), 'utf8').includes(f.message.text)));
});

test('a controller cannot resolve another controller, room, provider or Project origin', t => {
  const f = fixture(t); f.registry.begin(f.scope, f.message);
  f.registry.complete(f.scope, { ok: true, sessionId: 'native-chat' });
  assert.equal(f.registry.lookup({ ...f.scope, peerPublicKey: 'other' }, 'codex').state, 'waiting');
  assert.equal(f.registry.lookup({ ...f.scope, room: 'other' }, 'codex').state, 'waiting');
  assert.equal(f.registry.lookup(f.scope, 'grok').state, 'conflict');
  assert.equal(f.registry.lookup(f.scope, 'codex', 'other-project').state, 'conflict');
  assert.equal(f.registry.begin(f.scope, { ...f.message, text: 'Changed request' }).state, 'conflict');
});

test('a lost creation owner cannot authorize a duplicate new task', t => {
  const f = fixture(t); f.registry.begin(f.scope, f.message);
  const restarted = new TaskOriginRegistry(f.root, { ownerAlive: () => false });
  assert.equal(restarted.lookup(f.scope, 'codex').state, 'uncertain');
  assert.equal(restarted.begin(f.scope, f.message).state, 'uncertain');
  assert.equal(new TaskOriginRegistry(f.root, { now: () => Date.now() + 7 * 3_600_000 })
    .lookup(f.scope, 'codex').state, 'uncertain');
});

test('provider failure or a successful response without a native ID fails closed', t => {
  const f = fixture(t); f.registry.begin(f.scope, f.message);
  f.registry.complete(f.scope, { ok: false });
  assert.equal(f.registry.lookup(f.scope, 'codex').state, 'failed');
  const second = { ...f.scope, originMessageId: 'second' };
  f.registry.begin(second, { ...f.message, messageId: 'second' });
  f.registry.complete(second, { ok: true });
  assert.equal(f.registry.lookup(second, 'codex').state, 'uncertain');
  assert.throws(() => f.registry.complete({ ...f.scope, originMessageId: 'missing' }, { ok: false }));
});

test('corrupt state and expired creation records never authorize a continuation', t => {
  const f = fixture(t); f.registry.begin(f.scope, f.message);
  assert.equal(new TaskOriginRegistry(f.root, { now: () => Date.now() + 38 * 86_400_000 })
    .lookup(f.scope, 'codex').state, 'uncertain');
  const file = readdirSync(f.root).find(name => name.endsWith('.json'))!;
  writeFileSync(join(f.root, file), '{broken');
  assert.throws(() => f.registry.lookup(f.scope, 'codex'));
});

test('an unclaimed native invocation can release only its own unstarted reservation', t => {
  const f = fixture(t);
  f.registry.abandonBeforeStart(f.scope);
  f.registry.begin(f.scope, f.message);
  f.registry.abandonBeforeStart(f.scope);
  assert.equal(f.registry.begin(f.scope, f.message).state, 'started');
  f.registry.complete(f.scope, { ok: true, sessionId: 'native' });
  f.registry.abandonBeforeStart(f.scope);
  assert.equal(f.registry.lookup(f.scope, 'codex').state, 'ready');
});

test('transport timestamps do not change an origin, and a failed creation requires an explicit retry generation', t => {
  const f = fixture(t); f.registry.begin(f.scope, f.message);
  assert.equal(f.registry.begin(f.scope, { ...f.message, createdAt: 200 }).state, 'waiting');
  f.registry.complete(f.scope, { ok: false });
  assert.equal(f.registry.begin(f.scope, f.message).state, 'failed');
  assert.equal(f.registry.begin(f.scope, { ...f.message, retryId: 'explicit-retry' }).state, 'started');
  f.registry.complete(f.scope, { ok: false });
  assert.equal(f.registry.begin(f.scope, { ...f.message, retryId: 'explicit-retry' }).state, 'failed');
  assert.equal(f.registry.begin(f.scope, { ...f.message, retryId: 'second-retry' }).state, 'started');
});
