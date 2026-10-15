import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { TaskNetworkStore } from '../../../../../bridge/src/task-network';
import { networkFixture } from '../../../../../bridge/src/task-network/tests/fixture';
import { decodeProjectConfiguration } from '../../../../../bridge/src/task-network/configuration/ciphertext';
import { desktopProjectTransport } from '../index';

test('same-user native configuration publishes its own encrypted mailbox without creating a controller key', async () => {
  const f = networkFixture();
  try {
    const network = new TaskNetworkStore(join(f.root, 'native-transport'), 'target', f.target.publicKey, true);
    let uploads = 0;
    const options = { config: f.targetConfig, network, enabled: () => true, projectAllowed: (id: string) => id === 'project',
      request: async (input: any) => {
        uploads++;
        assert.equal(input.path.startsWith('/task-job-configurations/'), true);
        const record = { id: input.path.split('/').at(-1), ...input.body };
        assert.ok(decodeProjectConfiguration(record, { config: f.targetConfig, endpointId: 'target', projectId: 'project',
          controllers: [], controllerAllowed: () => false, allowNativeIssuer: true, now: Date.now() }));
        return { configuration: record };
      } };
    const result = await desktopProjectTransport({ action: 'configure', project_id: 'project',
      command: JSON.stringify(f.targetNetwork) }, options);
    assert.equal((result as any).ack.accepted, true);
    assert.equal(network.current('project', () => false)?.targetEndpointId, 'target');
    assert.equal(uploads, 1);
    assert.equal(await desktopProjectTransport({ action: 'descriptor', project_id: 'other' }, options), undefined);
    const disabled = await desktopProjectTransport({ action: 'configure', project_id: 'project',
      command: JSON.stringify(f.targetNetwork) }, { ...options, enabled: () => false });
    assert.equal(disabled, undefined);
    assert.equal(uploads, 1);
  } finally { f.cleanup(); }
});
