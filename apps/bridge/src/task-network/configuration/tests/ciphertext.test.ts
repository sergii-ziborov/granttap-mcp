import assert from 'node:assert/strict';
import test from 'node:test';
import { networkFixture } from '../../tests/fixture';
import { networkEnvelope } from '../../transport/ciphertext';
import { publicKeyIdentifier } from '../../../../../../packages/core/ciphertext-recipient';
import { decodeProjectConfiguration, projectConfigurationId } from '../ciphertext';

test('only a currently allowed controller can update the exact Project computer from relay ciphertext', () => {
  const f = networkFixture();
  try {
    const issuer = { ...f.targetConfig, myPublicKey: f.controller.publicKey, mySecretKey: f.controller.secretKey };
    const id = projectConfigurationId('project', 'target');
    const envelope = { ...networkEnvelope(issuer, { publicKey: f.target.publicKey, room: f.targetConfig.room,
      id, body: f.targetNetwork, expiresAt: f.targetNetwork.expiresAt }), from: 'phone' as const };
    const record = { id, issuerKeyId: publicKeyIdentifier(f.controller.publicKey), expiresAt: envelope.expiresAt, envelope };
    const input = { config: f.targetConfig, endpointId: 'target', projectId: 'project',
      controllers: [f.controller.publicKey], controllerAllowed: () => true, now: f.now };
    assert.deepEqual(decodeProjectConfiguration(record, input)?.command, f.targetNetwork);
    assert.equal(decodeProjectConfiguration(record, { ...input, controllerAllowed: () => false }), undefined);
    assert.equal(decodeProjectConfiguration(record, { ...input, projectId: 'different' }), undefined);
    assert.equal(decodeProjectConfiguration(record, { ...input, endpointId: 'source' }), undefined);
    assert.equal(decodeProjectConfiguration(record, { ...input, now: f.targetNetwork.expiresAt + 1 }), undefined);
  } finally { f.cleanup(); }
});

test('a same-computer native configuration has a separate issuer domain and never grants ordinary controller access', () => {
  const f = networkFixture();
  try {
    const id = projectConfigurationId('project', 'target');
    const envelope = networkEnvelope(f.targetConfig, { publicKey: f.target.publicKey, room: f.targetConfig.room,
      id, body: f.targetNetwork, expiresAt: f.targetNetwork.expiresAt });
    const record = { id, issuerKeyId: publicKeyIdentifier(f.target.publicKey), expiresAt: envelope.expiresAt, envelope };
    const input = { config: f.targetConfig, endpointId: 'target', projectId: 'project', controllers: [],
      controllerAllowed: () => false, now: f.now };
    assert.equal(decodeProjectConfiguration(record, input), undefined);
    assert.equal(decodeProjectConfiguration(record, { ...input, allowNativeIssuer: true })?.issuer,
      `native:${f.target.publicKey}`);
    assert.equal(decodeProjectConfiguration(record, { ...input, config: f.sourceConfig, allowNativeIssuer: true }), undefined);
  } finally { f.cleanup(); }
});
