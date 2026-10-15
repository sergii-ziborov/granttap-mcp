import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { loadRuntimeConfig } from '../../config';
import { localMeshStore } from '../../mesh/local-remote/local';
import { localTaskNetwork } from '../../task-network/runtime/configuration';
import { readProviderModelCatalog } from '../../provider-model-catalog';
import { TaskResourceReporter } from './reporter';
import { createHardwareSampler } from './hardware';
import { measuredDiskCapacity, measuredRepositoryRevision, measuredRepositoryRevisions, routingExecutableNames, routingProviderEntryPoints } from './observations';

export function startTaskResourceMonitor(input: { config: PeerConfig; peerAllowed: (key: string) => boolean;
  online: () => boolean }): () => void {
  let stopped = false;
  const network = localTaskNetwork(input.config);
  const reporter = new TaskResourceReporter({ config: input.config, network,
    controllerAllowed: input.peerAllowed, enabled: () => !stopped && loadRuntimeConfig().meshEnabled,
    online: input.online, os: process.platform, architecture: process.arch,
    repository: projectId => {
      const store = localMeshStore(), project = store.project(projectId);
      if (!project) return undefined;
      const path = store.workspaceForRepository(project.canonicalRepositoryId, network.endpointId);
      return path ? { id: project.canonicalRepositoryId, path } : undefined;
    },
    hardware: createHardwareSampler(), disk: measuredDiskCapacity, revision: measuredRepositoryRevision,
    revisions: measuredRepositoryRevisions,
    catalog: () => readProviderModelCatalog(network.endpointId), providers: routingProviderEntryPoints,
    tools: routingExecutableNames });
  const tick = () => { if (!stopped) void reporter.tick().catch(() => {}); };
  const timer = setInterval(tick, 30_000); timer.unref(); tick();
  return () => { stopped = true; clearInterval(timer); };
}
