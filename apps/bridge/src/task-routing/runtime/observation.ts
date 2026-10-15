import { setTimeout as delay } from 'node:timers/promises';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import type { TaskResourceReport } from '../../../../../packages/protocol/task-resources';
import { localMeshStore } from '../../mesh/local-remote/local';
import { inspectRepository } from '../../mesh/catalog';
import { localTaskNetwork } from '../../task-network/runtime/configuration';
import { controllerPeerGate } from '../../pairing/controllers';
import { readProviderModelCatalog } from '../../provider-model-catalog';
import { createHardwareSampler, type HardwareCapacity } from '../resources/hardware';
import { measuredDiskCapacity, measuredRepositoryRevision, measuredRepositoryRevisions, routingExecutableNames, routingProviderEntryPoints } from '../resources/observations';
import { buildResourceReport } from '../resources';

const sample = createHardwareSampler();
let hardware: Promise<HardwareCapacity> | undefined;
function currentHardware(path: string): Promise<HardwareCapacity> {
  if (hardware) return hardware;
  hardware = (async () => { await sample(path); await delay(200); return sample(path); })()
    .finally(() => { hardware = undefined; });
  return hardware;
}

/** Fresh local evidence uses the same report contract as encrypted peer observations. */
export async function observeRoutingComputer(config: PeerConfig, projectId: string, taskWorkspace?: string): Promise<TaskResourceReport | undefined> {
  const network = localTaskNetwork(config), transport = network.current(projectId, controllerPeerGate(config));
  const store = localMeshStore(), project = store.project(projectId);
  if (!transport?.routingEnabled || !project) return undefined;
  const bound = store.workspaceForRepository(project.canonicalRepositoryId, network.endpointId);
  const path = taskWorkspace ?? bound;
  if (taskWorkspace && (!bound || inspectRepository(taskWorkspace).canonicalRepositoryId !== project.canonicalRepositoryId)) return undefined;
  if (!path || !['darwin', 'win32', 'linux'].includes(process.platform)) return undefined;
  const [capacity, revision, disk] = await Promise.all([currentHardware(path), measuredRepositoryRevision(path), measuredDiskCapacity(path)]);
  if (!revision) return undefined;
  return buildResourceReport({ projectId, endpointId: network.endpointId,
    repositoryId: project.canonicalRepositoryId, revision, policyRevision: transport.revision,
    revisions: await measuredRepositoryRevisions(path),
    routingEnabled: true, os: process.platform, architecture: process.arch,
    hardware: { ...capacity, availableDiskBytes: disk }, tools: routingExecutableNames(),
    readyProviders: routingProviderEntryPoints(), catalog: readProviderModelCatalog(network.endpointId), now: Date.now() });
}
