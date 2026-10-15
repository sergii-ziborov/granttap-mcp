import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { MeshStore } from '../../../mesh/store';
import { TaskNetworkStore } from '../../../task-network';
import { networkFixture } from '../../../task-network/tests/fixture';
import { RoutingRequests } from '../../requests';
import { TaskResourceReport } from '../../../../../../packages/protocol/task-resources';
import type { SessionInfo } from '../../../../../../packages/protocol/schema';
import { TaskResourceRouter } from '../router';

test('resource selection prepares only the compatible computer and reconfirms current permission before upload', async () => {
  const f = networkFixture();
  try {
    const store = new MeshStore(join(f.root, 'mesh.json'));
    store.upsertProject({ projectId: 'project', name: 'Project', canonicalRepositoryId: 'repo', createdAt: f.now });
    store.upsertTask(f.job.operation.task); store.linkExecution(f.job.operation.sourceExecution);
    const network = new TaskNetworkStore(join(f.root, 'source-network'), 'source', f.source.publicKey);
    const configuration = { ...f.targetNetwork, targetEndpointId: 'source', routingEnabled: true, peers: [f.peer] };
    network.configure(configuration, f.controller.publicKey, () => true);
    const session: SessionInfo = { sessionId: 'source-chat', agent: 'codex', projectId: 'project', taskId: 'task',
      computerId: 'source', cwd: '/fixture', model: 'native-model', effort: 'high', state: 'idle',
      startedAt: f.now, lastActivityAt: f.now, tokensSession: 0, tokensLastTurn: 0 };
    const row = new RoutingRequests(join(f.root, 'requests')).request('operation', { sessionId: 'source-chat',
      provider: 'codex', projectId: 'project', taskId: 'task', model: 'native-model', effort: 'high' }, { reason: 'capacity' });
    const report = TaskResourceReport.parse({ type: 'mesh.resources', projectId: 'project', endpointId: 'source',
      policyRevision: 1, routingEnabled: true, generatedAt: f.now, expiresAt: f.now + 90_000,
      repositoryId: 'repo', revision: 'a'.repeat(40), os: 'darwin', architecture: 'arm64', cpuUtilization: 0.95,
      availableMemoryBytes: 16_000_000_000, availableDiskBytes: 8_000_000_000, tools: ['git'],
      providers: [{ provider: 'codex', ready: true, models: [{ id: 'native-model', observedAt: f.now, efforts: ['high'] }] }] });
    let prepares = 0;
    let currentSession: SessionInfo | undefined = session;
    const options = { config: f.sourceConfig, network, store, enabled: () => true, controllerAllowed: () => true,
      currentSession: async () => currentSession,
      refresh: async () => true, clean: () => true, observe: async () => report, now: () => f.now,
      peerReport: async () => ({ report: { ...report, endpointId: 'target', cpuUtilization: 0.1 }, receivedAt: f.now }),
      prepare: async (request: any, preparation: any) => {
        prepares++;
        assert.equal(request.prepareOnly, true); assert.equal(request.targetComputer, 'target');
        assert.equal(request.targetProvider, 'codex'); assert.equal(request.targetModel, 'native-model');
        assert.equal(preparation.forward.effort, 'high'); assert.equal(preparation.forward.model, 'native-model');
        assert.equal(await preparation.confirmPolicy(), true);
        currentSession = { ...session, effort: 'low' };
        assert.equal(await preparation.confirmPolicy(), false, 'Changing native effort during capture prevents upload.');
        currentSession = { ...session, state: 'working' };
        assert.equal(await preparation.confirmPolicy(), false, 'A new native turn prevents upload.');
        currentSession = undefined;
        assert.equal(await preparation.confirmPolicy(), false, 'A disappeared source prevents upload.');
        currentSession = session;
        network.configure({ ...configuration, createdAt: configuration.createdAt + 1, routingEnabled: false }, f.controller.publicKey, () => true);
        assert.equal(await preparation.confirmPolicy(), false, 'A disable during full capture prevents upload.');
        return true;
      } };
    assert.equal(await new TaskResourceRouter(options).route(row, session), true);
    assert.equal(prepares, 1);
    assert.equal(await new TaskResourceRouter(options).route(row, session), false);
    assert.equal(prepares, 1);
  } finally { f.cleanup(); }
});
