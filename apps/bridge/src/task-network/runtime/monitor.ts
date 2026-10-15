import { join } from 'node:path';
import type { PeerConfig, RelayClient } from '../../../../../packages/core/relay-client';
import { configDir, loadRuntimeConfig } from '../../config';
import { PeerTransferInbox } from '../storage/incoming';
import { networkDigest } from '../storage/private-file';
import { localTaskNetwork } from './configuration';
import { PeerTransferReceiver } from './receiver';
import { prepareNetworkTransfer, recoverNetworkTransfer } from './preparation';
import { localPeerTransferSender } from '../source/runtime';
import { startTaskResourceMonitor } from '../../task-routing/resources/runtime';
import { projectConfigurationPoller } from '../configuration/runtime';
import { admitAutomaticNetworkTransfer } from '../../task-routing/runtime/admission';
import { startAutomaticTaskRouting } from '../../task-routing/runtime';

/** A persistent, scoped receiver resumes independently of the phone or an originating CLI. */
export function startTaskNetworkMonitor(input: {
  config: PeerConfig; client: RelayClient; isLeader: () => boolean;
  peerAllowed: (key: string) => boolean; publish: () => Promise<void>;
}): () => void {
  let stopped = false, reportedAt = 0;
  const configuration = projectConfigurationPoller(input.config);
  const failure = () => {
    if (Date.now() - reportedAt < 60_000) return;
    reportedAt = Date.now();
    process.stderr.write('[monitor] Project computer transfer is waiting for storage or relay recovery.\n');
  };
  const receiver = new PeerTransferReceiver({ config: input.config, store: localTaskNetwork(input.config),
    inbox: new PeerTransferInbox(join(configDir(), 'task-network-inbox', networkDigest(input.config.room))),
    controllerAllowed: input.peerAllowed, enabled: () => loadRuntimeConfig().meshEnabled,
    online: () => !stopped && input.client.isConnected && input.isLeader(),
    prepare: prepareNetworkTransfer, recover: recoverNetworkTransfer,
    refreshConfiguration: id => configuration.sync.refresh(id),
    admitAutomatic: operation => admitAutomaticNetworkTransfer(input.config, operation),
    onChange: () => { void input.publish().catch(failure); }, onError: failure });
  const off = input.client.onTaskJobOffer(control => {
    void configuration.refresh().then(() => { if (!stopped) receiver.offer(control); }).catch(failure);
  });
  const sender = localPeerTransferSender(input.config, () => { void input.publish().catch(failure); });
  const stopResources = startTaskResourceMonitor({ config: input.config, peerAllowed: input.peerAllowed,
    online: () => !stopped && input.client.isConnected && input.isLeader() });
  const stopRouting = startAutomaticTaskRouting({ config: input.config, client: input.client, publish: input.publish,
    online: () => !stopped && input.client.isConnected && input.isLeader() });
  const tick = () => {
    void receiver.tick().catch(failure);
    if (!stopped && input.isLeader()) {
      void sender.tick().catch(failure);
      if (input.client.isConnected) void configuration.refresh().catch(failure);
    }
  };
  const timer = setInterval(tick, 2_000); timer.unref();
  tick();
  return () => { stopped = true; clearInterval(timer); off(); stopResources(); stopRouting(); };
}
