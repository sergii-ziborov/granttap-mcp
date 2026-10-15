import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutingRequests } from '../../requests';
import { admitTaskOffload } from '../index';

test('only attributed, enabled execution scope with confirmed current model and effort may request resource offload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-routing-admit-'));
  try {
    const store = new RoutingRequests(root), proof = { provider: 'codex' as const, sessionId: 'native-chat' };
    const source = { sessionId: 'virtual-chat', nativeSessionId: 'native-chat', projectId: 'project', taskId: 'task',
      provider: 'codex' as const, model: 'native-model', effort: 'high' as const };
    const ports = { store, enabled: () => true, source: () => source, allowed: async () => true };
    const input = { operationId: 'fixture', requirements: { reason: 'capacity' as const } };
    await assert.rejects(admitTaskOffload(input, undefined, ports), /attribut/i);
    await assert.rejects(admitTaskOffload(input, proof, { ...ports, allowed: async () => false }), /enable|permission/i);
    await assert.rejects(admitTaskOffload(input, proof, { ...ports, source: () => ({ ...source, effort: undefined }) }), /effort/i);
    const accepted = await admitTaskOffload(input, proof, ports);
    assert.equal(accepted.status, 'awaiting_idle');
    assert.match(store.blockReason('native-chat')!, /finish/i);
    const replay = await admitTaskOffload(input, proof, ports);
    assert.equal(replay.requestId, accepted.requestId);
    const cancelled = await admitTaskOffload({ action: 'cancel' }, proof, ports);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(store.blockReason('native-chat'), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
