import type { EndpointModelCatalog } from '../../../../../packages/protocol/schema';
import { TaskResourceReport } from '../../../../../packages/protocol/task-resources';
import type { RoutingCandidate } from '../index';
import type { HardwareCapacity } from './hardware';

type Input = { projectId: string; endpointId: string; repositoryId: string; revision: string;
  policyRevision: number; routingEnabled: boolean; os: string; architecture: string;
  revisions?: string[];
  hardware: HardwareCapacity; tools: string[]; readyProviders: RoutingCandidate['provider'][];
  catalog: EndpointModelCatalog; now: number };

/** Selected/observed models do not prove account availability; only fresh native advertisements do. */
export function buildResourceReport(input: Input): TaskResourceReport {
  const providers = (['claude', 'codex', 'cursor', 'grok'] as const).map(provider => {
    const models = input.catalog.models.filter(row => row.provider === provider
      && row.endpointId === input.endpointId && row.source === 'advertised'
      && row.observedAt <= input.now + 5_000 && input.now - row.observedAt <= 300_000)
      .slice(0, 16).map(row => ({ id: row.modelId, observedAt: row.observedAt,
        ...(row.supportedEfforts ? { efforts: row.supportedEfforts } : {}) }));
    const exhausted = input.catalog.accountUsage?.some(row => row.provider === provider
      && row.observedAt <= input.now + 5_000 && input.now - row.observedAt <= 300_000
      && row.windows.some(window => window.usedPercent >= 100 && window.resetsAt > input.now));
    return { provider, ready: input.readyProviders.includes(provider), models,
      ...(exhausted ? { quotaExhausted: true } : {}) };
  });
  return TaskResourceReport.parse({ type: 'mesh.resources', projectId: input.projectId, endpointId: input.endpointId,
    policyRevision: input.policyRevision, routingEnabled: input.routingEnabled,
    generatedAt: input.now, expiresAt: input.now + 90_000, repositoryId: input.repositoryId, revision: input.revision,
    os: input.os, architecture: input.architecture, revisions: input.revisions,
    ...input.hardware, tools: [...new Set(input.tools)].slice(0, 32), providers });
}
