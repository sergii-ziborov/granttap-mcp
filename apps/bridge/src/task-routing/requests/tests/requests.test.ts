import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutingRequests } from '../index';
import { RoutingRequestProcessor } from '../processor';

const source = { sessionId: 'source-chat', provider: 'codex' as const, projectId: 'project', taskId: 'task',
  model: 'native-model', effort: 'high' as const };
const requirements = { reason: 'required_hardware' as const, portable: false,
  minAvailableMemoryBytes: 2_000_000_000, minAvailableDiskBytes: 1_000_000_000, requiredTools: ['git'] };

test('an attributed routing request survives process exit and pauses only its source until the turn ends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-routing-requests-'));
  try {
    let store = new RoutingRequests(root);
    const row = store.request('operation', source, requirements, 100);
    assert.equal(store.request('operation', source, requirements, 101).id, row.id);
    assert.match(store.blockReason('source-chat', undefined, 101)!, /finish/i);
    assert.equal(store.blockReason('other-chat', undefined, 101), undefined);
    assert.equal(store.blockReason('source-chat', 'mcp__granttap__offload_task', 101), undefined);
    store = new RoutingRequests(root);
    let state = 'working', routes = 0;
    const processor = new RoutingRequestProcessor({ store, now: () => 102,
      session: () => ({ ...source, agent: source.provider, state }),
      route: async () => { routes++; return true; } });
    await processor.tick();
    assert.equal(routes, 0, 'The live turn must finish before full transcript capture.');
    state = 'idle';
    await processor.tick(); await processor.tick();
    assert.equal(routes, 1);
    assert.equal(store.get(row.id)?.phase, 'submitted');
    assert.equal(store.blockReason('source-chat', undefined, 103), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model changes, cancellation and expiry release the hold without launching another provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-routing-cancel-'));
  try {
    const store = new RoutingRequests(root), row = store.request('operation', source, requirements, 100);
    let routes = 0;
    await new RoutingRequestProcessor({ store, now: () => 101,
      session: () => ({ ...source, agent: 'codex', state: 'idle', model: 'changed-model' }),
      route: async () => { routes++; return true; } }).tick();
    assert.equal(store.get(row.id)?.phase, 'failed');
    assert.equal(routes, 0);
    const next = store.request('second', source, requirements, 102);
    assert.equal(store.cancel('other-chat'), false);
    assert.equal(store.cancel('source-chat'), true);
    assert.equal(store.get(next.id)?.phase, 'failed');
    const expired = store.request('third', source, requirements, 103);
    await new RoutingRequestProcessor({ store, now: () => expired.expiresAt + 1,
      session: () => ({ ...source, agent: 'codex', state: 'idle' }), route: async () => { routes++; return true; } }).tick();
    assert.equal(store.get(expired.id)?.phase, 'failed');
    assert.equal(store.blockReason('source-chat', undefined, expired.expiresAt + 1), undefined);
    assert.equal(routes, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
