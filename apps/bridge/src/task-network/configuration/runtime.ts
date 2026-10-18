import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { loadConfig, machineConfigPath } from '../../config';
import { controllerPeerGate } from '../../pairing/controllers';
import { localMeshStore } from '../../mesh/local-remote/local';
import { localTaskNetwork } from '../runtime/configuration';
import { ProjectConfigurationSync } from './sync';

export function localProjectConfigurationSync(config: PeerConfig): ProjectConfigurationSync {
  const network = localTaskNetwork(config);
  const current = () => {
    const live = loadConfig(machineConfigPath());
    if (live.room !== config.room || live.myPublicKey !== config.myPublicKey) {
      throw new Error('The Project pairing changed.');
    }
    return live;
  };
  return new ProjectConfigurationSync({ config, store: network, allowNativeIssuer: true,
    controllers: () => { const live = current(); return [live.peerPublicKey, ...live.extraPeerPublicKeys ?? []]; },
    controllerAllowed: key => controllerPeerGate(current())(key),
    projectAllowed: projectId => {
      const store = localMeshStore(), project = store.project(projectId);
      return Boolean(project && store.workspaceForRepository(project.canonicalRepositoryId, network.endpointId));
    } });
}

/** Bounded startup/reconnect refresh also discovers grants for a computer previously offline. */
export function projectConfigurationPoller(config: PeerConfig): { refresh: () => Promise<void>; sync: ProjectConfigurationSync } {
  const sync = localProjectConfigurationSync(config);
  let pending: Promise<void> | undefined, refreshedAt = 0;
  const run = async () => {
    const ids = localMeshStore().projectIds().slice(0, 128);
    for (let offset = 0; offset < ids.length; offset += 4) {
      await Promise.all(ids.slice(offset, offset + 4).map(id => sync.refresh(id, { background: true })));
    }
    refreshedAt = Date.now();
  };
  return { sync, refresh: () => {
    if (pending) return pending;
    if (Date.now() - refreshedAt < 30_000) return Promise.resolve();
    pending = run().finally(() => { pending = undefined; });
    return pending;
  } };
}
