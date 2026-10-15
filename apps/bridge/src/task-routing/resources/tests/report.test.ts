import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResourceReport } from '../index';

test('routing advertises measured capacity and only fresh native model availability for every existing provider', () => {
  const now = Date.now();
  const input: Parameters<typeof buildResourceReport>[0] = { projectId: 'project', endpointId: 'target',
    revision: 'a'.repeat(40), repositoryId: 'repo', policyRevision: 1, routingEnabled: true, os: 'linux', architecture: 'x64',
    hardware: { cpuUtilization: 0.2, availableMemoryBytes: 2_000_000 }, tools: ['git'],
    readyProviders: ['codex', 'cursor', 'grok', 'claude'], now,
    catalog: { endpointId: 'target', observedAt: now, models: [
      { endpointId: 'target', provider: 'codex', modelId: 'model', source: 'advertised', observedAt: now, supportedEfforts: ['high'] },
      { endpointId: 'target', provider: 'claude', modelId: 'observed-only', source: 'observed', observedAt: now },
      { endpointId: 'target', provider: 'cursor', modelId: 'expired', source: 'advertised', observedAt: now - 300_001 },
      { endpointId: 'target', provider: 'grok', modelId: 'model', source: 'advertised', observedAt: now },
    ] } };
  const report = buildResourceReport(input);
  assert.equal(report.cpuUtilization, 0.2);
  assert.equal(report.providers.length, 4);
  assert.deepEqual(report.providers.find(row => row.provider === 'codex')?.models,
    [{ id: 'model', observedAt: now, efforts: ['high'] }]);
  assert.deepEqual(report.providers.find(row => row.provider === 'claude')?.models, []);
  assert.deepEqual(report.providers.find(row => row.provider === 'cursor')?.models, []);
  assert.equal(report.providers.find(row => row.provider === 'grok')?.models.length, 1);
  const disabled = buildResourceReport({ ...input, routingEnabled: false, readyProviders: [] });
  assert.equal(disabled.routingEnabled, false);
  assert.ok(disabled.providers.every(row => !row.ready));
});
