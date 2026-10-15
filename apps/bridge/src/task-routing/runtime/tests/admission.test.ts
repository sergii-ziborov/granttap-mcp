import assert from 'node:assert/strict';
import test from 'node:test';
import { networkFixture } from '../../../task-network/tests/fixture';
import { PeerTaskTransfer } from '../../../../../../packages/protocol/task-network';
import { TaskResourceReport } from '../../../../../../packages/protocol/task-resources';
import { automaticTransferAdmissionReason } from '../admission';

test('the destination repeats hardware, model, effort, repository and cross-platform admission from fresh local evidence', () => {
  const f = networkFixture();
  try {
    const operation = PeerTaskTransfer.parse({ ...f.job.operation, automatic: true,
      event: { ...f.job.operation.event, payload: { ...f.job.operation.event.payload,
        capsule: { ...f.job.operation.event.payload.capsule, targetProvider: 'codex', targetModel: 'native-model' } } },
      routing: { sourceOS: 'darwin', sourceArchitecture: 'arm64', portable: true, minAvailableMemoryBytes: 4_000_000_000,
        minAvailableDiskBytes: 1_000_000_000, requiredTools: ['git'], gpuVendor: 'nvidia', minGpuMemoryBytes: 4_000_000_000 },
      forward: { text: 'Continue the same synthetic task', model: 'native-model', effort: 'high' } });
    const configuration = { ...f.targetNetwork, routingEnabled: true };
    const report = TaskResourceReport.parse({ type: 'mesh.resources', projectId: 'project', endpointId: 'target',
      policyRevision: 1, routingEnabled: true, generatedAt: f.now, expiresAt: f.now + 90_000,
      repositoryId: 'repo', revision: 'a'.repeat(40), os: 'darwin', architecture: 'arm64', cpuUtilization: 0.1,
      availableMemoryBytes: 16_000_000_000, availableDiskBytes: 8_000_000_000,
      gpu: { vendor: 'nvidia', available: true, memoryBytes: 8_000_000_000 }, tools: ['git'],
      providers: [{ provider: 'codex', ready: true, models: [{ id: 'native-model', observedAt: f.now, efforts: ['high'] }] }] });
    assert.equal(automaticTransferAdmissionReason(operation, report, configuration, f.now), undefined);
    assert.equal(automaticTransferAdmissionReason(operation, { ...report, gpu: undefined }, configuration, f.now), 'gpu_unavailable');
    assert.equal(automaticTransferAdmissionReason(operation, { ...report, revision: 'b'.repeat(40) }, configuration, f.now), 'repository_revision');
    assert.equal(automaticTransferAdmissionReason(operation, { ...report, os: 'win32' }, configuration, f.now), 'platform_mismatch');
    assert.equal(automaticTransferAdmissionReason(operation, { ...report, os: 'win32' },
      { ...configuration, allowCrossPlatform: true }, f.now), undefined);
    assert.equal(automaticTransferAdmissionReason(operation, report, configuration, f.now + 91_000), 'computer_unavailable');
  } finally { f.cleanup(); }
});
