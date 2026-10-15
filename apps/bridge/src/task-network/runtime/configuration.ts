import { join } from 'node:path';
import type { RelayClient, PeerConfig } from '../../../../../packages/core/relay-client';
import type { ProjectTransportSet } from '../../../../../packages/protocol/task-network';
import { configDir, loadConfig, loadRuntimeConfig, machineConfigPath } from '../../config';
import { observedComputerId } from '../../mesh/identity/computer';
import { localMeshStore } from '../../mesh/local-remote/local';
import { controllerPeerGate } from '../../pairing/controllers';
import { TaskNetworkStore } from '../index';

let cached: { root: string; publicKey: string; store: TaskNetworkStore } | undefined;
export function localTaskNetwork(config: PeerConfig = loadConfig(machineConfigPath())): TaskNetworkStore {
  const root = join(configDir(), 'task-network');
  if (cached?.root !== root || cached.publicKey !== config.myPublicKey) {
    cached = { root, publicKey: config.myPublicKey, store: new TaskNetworkStore(root, observedComputerId(), config.myPublicKey, true) };
  }
  return cached.store;
}

export async function handleProjectTransportConfiguration(client: RelayClient,
  command: ProjectTransportSet, controller?: string): Promise<boolean> {
  const config = loadConfig(machineConfigPath());
  let accepted = false;
  if (controller && controllerPeerGate(config)(controller) && loadRuntimeConfig().meshEnabled) {
    accepted = localTaskNetwork(config).configure(command, controller, projectId => {
      if (!command.enabled) return true;
      const store = localMeshStore(), project = store.project(projectId);
      return Boolean(project && store.workspaceForRepository(project.canonicalRepositoryId, observedComputerId()));
    });
  }
  await client.send({ type: 'project.transport.ack', sessionId: command.projectId, projectId: command.projectId,
    targetEndpointId: observedComputerId(), requestId: command.requestId, revision: command.revision,
    accepted, generatedAt: Date.now() }, 'phone', { peerPublicKey: controller, ttlMs: 60_000 });
  return accepted;
}
