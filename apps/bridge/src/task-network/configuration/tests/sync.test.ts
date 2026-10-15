import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { networkFixture } from '../../tests/fixture';
import { TaskNetworkStore } from '../../index';
import { networkEnvelope } from '../../transport/ciphertext';
import { publicKeyIdentifier } from '../../../../../../packages/core/ciphertext-recipient';
import { ProjectConfigurationSync } from '../sync';
import { projectConfigurationId } from '../ciphertext';

test('fresh relay configuration bootstraps offline computers and disabling survives phone exit', async () => {
  const f = networkFixture();
  try {
    const store = new TaskNetworkStore(join(f.root, 'fresh'), 'target', f.target.publicKey);
    const issuer = { ...f.targetConfig, myPublicKey: f.controller.publicKey, mySecretKey: f.controller.secretKey };
    const id = projectConfigurationId('project', 'target');
    let command = f.targetNetwork, allowed = true, reads = 0;
    const sync = new ProjectConfigurationSync({ config: f.targetConfig, store,
      controllers: () => [f.controller.publicKey], controllerAllowed: () => allowed, projectAllowed: () => true,
      request: async () => {
        reads++;
        const envelope = { ...networkEnvelope(issuer, { id, room: f.targetConfig.room,
          publicKey: f.target.publicKey, body: command, expiresAt: command.expiresAt }), from: 'phone' as const };
        return { configuration: { id, expiresAt: envelope.expiresAt,
          issuerKeyId: publicKeyIdentifier(f.controller.publicKey), envelope } };
      } });
    assert.equal(await sync.refresh('project'), true);
    assert.equal(store.current('project', () => true)?.revision, 1);
    command = { ...command, createdAt: command.createdAt + 1, enabled: false, peers: [] };
    assert.equal(await sync.refresh('project'), true);
    assert.equal(store.current('project', () => true), undefined);
    allowed = false;
    assert.equal(await sync.refresh('project'), false, 'A revoked phone cannot renew configuration.');
    assert.equal(reads, 3);
  } finally { f.cleanup(); }
});

test('same-user native issuer is accepted only in its explicitly enabled store', () => {
  const f = networkFixture();
  try {
    const issuer = `native:${f.target.publicKey}`;
    const remote = new TaskNetworkStore(join(f.root, 'remote'), 'target', f.target.publicKey);
    assert.equal(remote.configure(f.targetNetwork, issuer, () => true), false);
    const native = new TaskNetworkStore(join(f.root, 'native'), 'target', f.target.publicKey, true);
    assert.equal(native.configure(f.targetNetwork, issuer, () => true), true);
    assert.equal(native.current('project', () => false)?.revision, 1);
    assert.equal(native.configure(f.targetNetwork, `native:${f.source.publicKey}`, () => true), false);
  } finally { f.cleanup(); }
});
