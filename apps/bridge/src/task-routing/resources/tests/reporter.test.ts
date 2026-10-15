import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskResourceReporter } from '../reporter';
import { networkFixture } from '../../../task-network/tests/fixture';
import type { TaskResourceReport } from '../../../../../../packages/protocol/task-resources';

test('disabled automatic routing publishes no capacity; enabling publishes only the authorized repository with measured data', async () => {
  const f = networkFixture();
  try {
    const reports: TaskResourceReport[] = [];
    const reporter = new TaskResourceReporter({ config: f.targetConfig, network: f.store,
      controllerAllowed: () => true, enabled: () => true, online: () => true,
      repository: projectId => projectId === 'project' ? { id: 'repo', path: '/fixture/authorized' } : undefined,
      hardware: async () => ({ availableMemoryBytes: 16_000_000 }), disk: async () => 30_000_000,
      revision: async path => { assert.equal(path, '/fixture/authorized'); return 'a'.repeat(40); },
      catalog: () => ({ endpointId: 'target', observedAt: f.now, models: [] }), providers: () => [], tools: () => ['git'],
      os: 'linux', architecture: 'x64', now: () => f.now + 2,
      publish: async (_config, peer, report) => {
        assert.equal(peer.endpointId, 'source'); reports.push(report);
      } });
    await reporter.tick(); assert.equal(reports.length, 0);
    f.store.configure({ ...f.targetNetwork, routingEnabled: true, createdAt: f.now + 1 }, f.controller.publicKey, () => true);
    await reporter.tick();
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.projectId, 'project');
    assert.equal(reports[0]?.repositoryId, 'repo');
    assert.equal(reports[0]?.cpuUtilization, undefined, 'Unknown capacity must not become idle.');
    assert.equal(reports[0]?.availableMemoryBytes, 16_000_000);
    assert.equal(reports[0]?.availableDiskBytes, 30_000_000);
    f.store.configure({ ...f.targetNetwork, routingEnabled: false, createdAt: f.now + 3 }, f.controller.publicKey, () => true);
    await reporter.tick(); assert.equal(reports.length, 1);
  } finally { f.cleanup(); }
});

test('revoking routing while a resource measurement is pending prevents publication under the old grant', async () => {
  const f = networkFixture();
  try {
    f.store.configure({ ...f.targetNetwork, routingEnabled: true, createdAt: f.now + 1 }, f.controller.publicKey, () => true);
    let reports = 0;
    const reporter = new TaskResourceReporter({ config: f.targetConfig, network: f.store,
      controllerAllowed: () => true, enabled: () => true, online: () => true,
      repository: () => ({ id: 'repo', path: '/fixture/authorized' }), hardware: async () => ({}),
      disk: async () => {
        f.store.configure({ ...f.targetNetwork, routingEnabled: false, createdAt: f.now + 2 }, f.controller.publicKey, () => true);
        return 100;
      },
      revision: async () => 'a'.repeat(40), catalog: () => ({ endpointId: 'target', observedAt: f.now, models: [] }),
      providers: () => [], tools: () => [], os: 'linux', architecture: 'x64',
      publish: async () => { reports++; } });
    await reporter.tick();
    assert.equal(reports, 0);
  } finally { f.cleanup(); }
});
