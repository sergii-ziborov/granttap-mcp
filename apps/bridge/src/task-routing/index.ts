export type RoutingCandidate = {
  endpointId: string; projectId: string; repositoryId: string; revision: string;
  revisions?: string[];
  observedAt: number; receivedAt: number; online: boolean; routingEnabled: boolean; policyRevision: number;
  os: string; architecture: string; cpuUtilization?: number; availableMemoryBytes?: number;
  availableDiskBytes?: number;
  gpu?: { vendor: string; available: boolean; memoryBytes?: number };
  provider: 'claude' | 'codex' | 'cursor' | 'grok'; providerReady?: boolean;
  modelId: string; modelConfirmed: boolean; modelObservedAt: number; supportedEfforts?: string[];
  requiredToolsPresent?: boolean; quotaExhausted?: boolean;
};
export type RoutingRequirements = {
  projectId: string; repositoryId: string; revision: string; sourceEndpointId: string;
  provider: RoutingCandidate['provider']; modelId: string; effort?: string;
  sourceOS: string; sourceArchitecture: string; portable: boolean;
  minAvailableMemoryBytes: number; minAvailableDiskBytes?: number;
  gpuVendor?: string; minGpuMemoryBytes?: number; lastTransferAt?: number;
  visitedEndpoints?: string[]; hops?: number; reason: 'capacity' | 'required_hardware';
};
export type ResourceRoutingPolicy = {
  enabled: boolean; revision: number; allowCrossPlatform: boolean; cooldownMs: number;
};
export type RoutingDecision = { target?: RoutingCandidate; reason: string;
  rejected: Array<{ endpointId: string; reason: string }> };

const fresh = (at: number, now: number, maxAge: number) => Number.isFinite(at)
  && at > 0 && at <= now + 5_000 && now - at <= maxAge;
const amount = (value: number | undefined, minimum: number) => value !== undefined
  && Number.isFinite(value) && value >= minimum;

/** Selects only positively compatible capacity. The receiver still performs final admission. */
export function selectTaskComputer(input: {
  policy: ResourceRoutingPolicy; request: RoutingRequirements; candidates: RoutingCandidate[]; now: number;
}): RoutingDecision {
  const { policy, request, candidates, now } = input;
  if (!policy.enabled) return { reason: 'routing_disabled', rejected: [] };
  if ((request.hops ?? 0) >= 2) return { reason: 'hop_limit', rejected: [] };
  if (request.lastTransferAt != null && (!Number.isFinite(request.lastTransferAt)
    || now - request.lastTransferAt < policy.cooldownMs)) return { reason: 'cooldown', rejected: [] };
  const source = candidates.find(candidate => candidate.endpointId === request.sourceEndpointId);
  const memoryPressure = source && amount(source.availableMemoryBytes, 0)
    && source.availableMemoryBytes! < request.minAvailableMemoryBytes;
  if (request.reason === 'capacity' && (!source || !fresh(source.receivedAt, now, 90_000)
    || !fresh(source.observedAt, now, 90_000) || !amount(source.cpuUtilization, 0) && !memoryPressure)) {
    return { reason: 'source_capacity_unknown', rejected: [] };
  }
  const rejected: RoutingDecision['rejected'] = [], eligible: RoutingCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.endpointId === request.sourceEndpointId) continue;
    const reason = incompatibility(candidate, request, policy, now);
    if (reason) { rejected.push({ endpointId: candidate.endpointId, reason }); continue; }
    if (request.reason === 'capacity' && !memoryPressure && candidate.cpuUtilization! + 0.2 >= source!.cpuUtilization!) {
      rejected.push({ endpointId: candidate.endpointId, reason: 'no_capacity_improvement' }); continue;
    }
    eligible.push(candidate);
  }
  eligible.sort((left, right) => left.cpuUtilization! - right.cpuUtilization!
    || right.availableMemoryBytes! - left.availableMemoryBytes!
    || left.endpointId.localeCompare(right.endpointId));
  return { target: eligible[0], reason: eligible.length ? 'compatible_capacity' : 'no_compatible_computer', rejected };
}

function incompatibility(candidate: RoutingCandidate, request: RoutingRequirements,
  policy: ResourceRoutingPolicy, now: number): string | undefined {
  if (candidate.projectId !== request.projectId || candidate.repositoryId !== request.repositoryId) return 'project_scope';
  if (!candidate.routingEnabled || candidate.policyRevision !== policy.revision) return 'computer_policy';
  if (!candidate.online || !fresh(candidate.receivedAt, now, 90_000)
    || !fresh(candidate.observedAt, now, 90_000)) return 'computer_unavailable';
  if (request.visitedEndpoints?.includes(candidate.endpointId)) return 'routing_loop';
  if (candidate.revision !== request.revision && !candidate.revisions?.includes(request.revision)) return 'repository_revision';
  if (candidate.provider !== request.provider || candidate.providerReady !== true) return 'provider_unavailable';
  if (!candidate.modelConfirmed || candidate.modelId !== request.modelId
    || !fresh(candidate.modelObservedAt, now, 300_000)) return 'model_unavailable';
  if (request.effort && !candidate.supportedEfforts?.includes(request.effort)) return 'effort_unavailable';
  if (candidate.quotaExhausted) return 'quota_exhausted';
  if (candidate.requiredToolsPresent !== true) return 'tools_unconfirmed';
  if (!(request.portable && policy.allowCrossPlatform)
    && (candidate.os !== request.sourceOS || candidate.architecture !== request.sourceArchitecture)) return 'platform_mismatch';
  if (!amount(candidate.availableMemoryBytes, request.minAvailableMemoryBytes)) return 'memory_unavailable';
  if (request.minAvailableDiskBytes != null && !amount(candidate.availableDiskBytes, request.minAvailableDiskBytes)) return 'disk_unavailable';
  if (!amount(candidate.cpuUtilization, 0) || candidate.cpuUtilization! > 0.75) return 'computer_busy';
  if (request.gpuVendor && (!candidate.gpu?.available || candidate.gpu.vendor !== request.gpuVendor)) return 'gpu_unavailable';
  if (request.minGpuMemoryBytes != null && (!candidate.gpu?.available
    || !amount(candidate.gpu.memoryBytes, request.minGpuMemoryBytes))) return 'gpu_memory_unavailable';
  return undefined;
}

/** Receiving computers repeat compatibility checks against their own fresh observations. */
export function routingAdmissionReason(candidate: RoutingCandidate, request: RoutingRequirements,
  policy: ResourceRoutingPolicy, now: number): string | undefined {
  return !policy.enabled ? 'routing_disabled' : incompatibility(candidate, request, policy, now);
}
