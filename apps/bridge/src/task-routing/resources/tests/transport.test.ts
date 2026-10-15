import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskResourceReport } from '../../../../../../packages/protocol/task-resources';
import { networkFixture } from '../../../task-network/tests/fixture';
import { candidatesFromReport, publishPeerResources, readPeerResources } from '../transport';

test('capacity reports are encrypted for their exact Project peer, scoped writer and policy revision', async () => {
  const f = networkFixture();
  try {
    const report = TaskResourceReport.parse({ type: 'mesh.resources', projectId: 'project', endpointId: 'target',
      policyRevision: 1, generatedAt: f.now, expiresAt: f.now + 60_000, routingEnabled: true,
      repositoryId: 'repo', revision: 'a'.repeat(40), os: 'linux', architecture: 'x64',
      cpuUtilization: 0.1, availableMemoryBytes: 16_000_000_000, availableDiskBytes: 30_000_000_000,
      tools: ['git', 'node'], providers: [{ provider: 'codex', ready: true,
        models: [{ id: 'selected-model', observedAt: f.now, efforts: ['high'] }] }] });
    let requestPath = '', body: unknown;
    const outgoingPeer = f.targetNetwork.peers[0]!;
    const transport: any = async (input: any) => {
      requestPath = input.path;
      if (input.method === 'PUT') { body = input.body; return { ok: true }; }
      return body;
    };
    await publishPeerResources(f.targetConfig, outgoingPeer, report, transport);
    assert.equal(requestPath, `/task-resources/${f.peer.outgoing.writerId}`);
    assert.ok(!JSON.stringify(body).includes('selected-model'));
    const loaded = await readPeerResources(f.sourceConfig, f.peer, { projectId: 'project', revision: 1 }, transport, f.now);
    assert.deepEqual(loaded?.report, report);
    assert.equal(loaded?.receivedAt, f.now);
    assert.equal(await readPeerResources(f.sourceConfig, f.peer, { projectId: 'other', revision: 1 }, transport, f.now), undefined);
    assert.equal(await readPeerResources(f.sourceConfig, f.peer, { projectId: 'project', revision: 2 }, transport, f.now), undefined);
    assert.equal(await readPeerResources(f.sourceConfig, f.peer, { projectId: 'project', revision: 1 }, transport, f.now + 90_001), undefined);
    const [candidate] = candidatesFromReport(report, f.now, 'codex', 'selected-model', ['git', 'node']);
    assert.equal(candidate?.requiredToolsPresent, true);
    assert.equal(candidate?.modelConfirmed, true);
    assert.deepEqual(candidate?.supportedEfforts, ['high']);
    assert.equal(candidatesFromReport(report, f.now, 'codex', 'missing', ['nvcc'])[0]?.modelConfirmed, false);
    assert.equal(candidatesFromReport(report, f.now, 'codex', 'selected-model', ['nvcc'])[0]?.requiredToolsPresent, false);
  } finally { f.cleanup(); }
});
