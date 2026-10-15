import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTaskComputer, type RoutingCandidate } from '../index';
const now = 1_000_000;
const candidate = (id: string, extra: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
  endpointId: id, projectId: 'project', receivedAt: now, observedAt: now, online: true,
  routingEnabled: true, policyRevision: 3, repositoryId: 'repo', revision: 'a'.repeat(40),
  os: 'darwin', architecture: 'arm64', cpuUtilization: 0.1, availableMemoryBytes: 16_000_000_000,
  gpu: { vendor: 'apple', available: true, memoryBytes: 8_000_000_000 },
  provider: 'codex', providerReady: true, modelId: 'fixture-model', modelConfirmed: true,
  modelObservedAt: now, supportedEfforts: ['high'], requiredToolsPresent: true,
  ...extra,
});
const request = { projectId: 'project', repositoryId: 'repo', revision: 'a'.repeat(40),
  sourceEndpointId: 'source', provider: 'codex' as const, modelId: 'fixture-model', effort: 'high',
  sourceOS: 'darwin', sourceArchitecture: 'arm64', portable: false,
  minAvailableMemoryBytes: 4_000_000_000, reason: 'capacity' as const };
const policy = { enabled: true, revision: 3, allowCrossPlatform: false, cooldownMs: 300_000 };

test('routing chooses a compatible idle computer with the same exact provider, model and effort', () => {
  const result = selectTaskComputer({ policy, request, now,
    candidates: [candidate('source', { cpuUtilization: 0.95 }), candidate('target')] });
  assert.equal(result.target?.endpointId, 'target');
  assert.equal(selectTaskComputer({ policy: { ...policy, enabled: false }, request, now,
    candidates: [candidate('target')] }).target, undefined);
});

test('confirmed source memory pressure permits a compatible computer even when CPU is already quiet', () => {
  const result = selectTaskComputer({ policy, request, now, candidates: [
    candidate('source', { cpuUtilization: 0.05, availableMemoryBytes: 128_000_000 }),
    candidate('target', { cpuUtilization: 0.1 }),
  ] });
  assert.equal(result.target?.endpointId, 'target');
});

test('unknown, stale, unauthorized, exhausted or incompatible capacity never authorizes an offload', () => {
  const changes: Partial<RoutingCandidate>[] = [
    { projectId: 'other' }, { routingEnabled: false }, { online: false }, { policyRevision: 2 },
    { repositoryId: 'other' }, { revision: 'b'.repeat(40) }, { receivedAt: now - 180_000 },
    { observedAt: now + 10_000 }, { providerReady: undefined }, { modelConfirmed: false },
    { provider: 'grok' }, { modelId: 'another-model' }, { supportedEfforts: ['low'] },
    { availableMemoryBytes: undefined }, { availableMemoryBytes: 1 }, { cpuUtilization: undefined },
    { cpuUtilization: 0.95 }, { quotaExhausted: true }, { requiredToolsPresent: false },
    { os: 'win32' }, { architecture: 'x64' },
  ];
  for (const change of changes) assert.equal(selectTaskComputer({ policy, request, now,
    candidates: [candidate('source', { cpuUtilization: 0.9 }), candidate('target', change)] }).target, undefined,
    `Rejected incompatible capacity: ${Object.keys(change).join(',')}`);
});

test('explicit portable GPU work can move to a ready NVIDIA host; cooldown and fresh admission still apply', () => {
  const gpuRequest = { ...request, portable: true, reason: 'required_hardware' as const,
    gpuVendor: 'nvidia' as const, minGpuMemoryBytes: 8_000_000_000 };
  const crossPolicy = { ...policy, allowCrossPlatform: true };
  const source = candidate('source');
  const nvidia = candidate('nvidia', { os: 'win32', architecture: 'x64',
    gpu: { vendor: 'nvidia', available: true, memoryBytes: 12_000_000_000 } });
  assert.equal(selectTaskComputer({ policy: crossPolicy, request: gpuRequest, now,
    candidates: [source, nvidia] }).target?.endpointId, 'nvidia');
  assert.equal(selectTaskComputer({ policy: crossPolicy, request: { ...gpuRequest, lastTransferAt: now - 1_000 }, now,
    candidates: [source, nvidia] }).target, undefined);
  assert.equal(selectTaskComputer({ policy: crossPolicy, request: gpuRequest, now,
    candidates: [source, { ...nvidia, gpu: { ...nvidia.gpu!, available: false } }] }).target, undefined);
});
