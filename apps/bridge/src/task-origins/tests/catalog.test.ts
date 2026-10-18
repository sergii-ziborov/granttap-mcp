import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskOriginRegistry, decorateTaskOriginCatalog } from '../index';
import type { SessionsStatus } from '../../../../../packages/protocol/schema';

test('a fresh catalog restores native identity after the controller missed the creation response', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-origin-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new TaskOriginRegistry(root);
  const scope = { room: 'room', peerPublicKey: 'controller', originMessageId: 'origin' };
  registry.begin(scope, { type: 'user.message', agent: 'codex', text: 'Synthetic parent', createdAt: 1 });
  registry.complete(scope, { ok: true, sessionId: 'native' });
  const session = { sessionId: 'native', agent: 'codex' as const, state: 'idle' as const,
    startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 };
  const status: SessionsStatus = { type: 'sessions.status', machine: 'Fixture', generatedAt: Date.now(),
    sessions: [session], history: [session], tokensRecent: 0, tokenWindowHours: 24 };
  const expected = [{ originId: 'origin', controllerPublicKey: 'controller' }];
  const decorated = decorateTaskOriginCatalog(status, 'room', registry);
  assert.deepEqual(decorated.sessions[0]?.creationOrigins, expected);
  assert.deepEqual(decorated.history?.[0]?.creationOrigins, expected);
  assert.deepEqual(decorateTaskOriginCatalog(status, 'room', registry).sessions[0]?.creationOrigins, expected,
    'cached routing metadata remains stable across catalog publications');
  assert.equal(decorateTaskOriginCatalog(status, 'other-room', registry).sessions[0]?.creationOrigins, undefined);
  assert.equal(decorateTaskOriginCatalog({ ...status, sessions: [{ ...session, agent: 'grok' }] }, 'room', registry)
    .sessions[0]?.creationOrigins, undefined);
  assert.equal(status.sessions[0]?.creationOrigins, undefined, 'the original scan remains unmodified');
  const expired = new TaskOriginRegistry(root, { now: () => Date.now() + 38 * 86_400_000 });
  assert.equal(decorateTaskOriginCatalog(status, 'room', expired).sessions[0]?.creationOrigins, undefined);
  const file = readdirSync(root).find(name => name.endsWith('.json'))!;
  writeFileSync(join(root, file), '{broken');
  assert.equal(decorateTaskOriginCatalog(status, 'room', registry).sessions[0]?.creationOrigins, undefined);
  rmSync(root, { recursive: true });
  assert.equal(decorateTaskOriginCatalog(status, 'room', registry), status,
    'unavailable recovery metadata must not block the normal catalog');
});
