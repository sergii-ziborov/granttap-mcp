import type { PeerConfig } from '../../../../../packages/core/relay-client';
import type { EndpointModelCatalog } from '../../../../../packages/protocol/schema';
import type { TaskNetworkStore } from '../../task-network';
import type { RoutingCandidate } from '../index';
import type { HardwareCapacity } from './hardware';
import { buildResourceReport } from './index';
import { publishPeerResources } from './transport';

type Repository = { id: string; path: string };
type Options = { config: PeerConfig; network: TaskNetworkStore; controllerAllowed: (key: string) => boolean;
  enabled: () => boolean; online: () => boolean; repository: (project: string) => Repository | undefined;
  hardware: (path: string) => Promise<HardwareCapacity>; disk: (path: string) => Promise<number | undefined>;
  revision: (path: string) => Promise<string | undefined>; catalog: () => EndpointModelCatalog;
  revisions?: (path: string) => Promise<string[]>;
  providers: () => RoutingCandidate['provider'][]; tools: () => string[];
  os: string; architecture: string; publish?: typeof publishPeerResources; now?: () => number };

/** Reports only controller-enabled Project capacity and never blocks a chat/control handler. */
export class TaskResourceReporter {
  private busy = false;
  constructor(private readonly input: Options) {}

  async tick(): Promise<void> {
    if (this.busy || !this.input.enabled() || !this.input.online()) return;
    const now = (this.input.now ?? Date.now)();
    const configurations = this.input.network.all(this.input.controllerAllowed, now)
      .filter(config => config.routingEnabled)
      .flatMap(config => {
        const repository = this.input.repository(config.projectId);
        return repository ? [{ config, repository }] : [];
      });
    if (!configurations.length) return;
    this.busy = true;
    try {
      const hardware = await this.input.hardware(configurations[0]!.repository.path);
      const catalog = this.input.catalog(), providers = this.input.providers(), tools = this.input.tools();
      for (const { config, repository } of configurations) {
        if (!this.input.enabled() || !this.input.online()) return;
        const current = this.input.network.current(config.projectId, this.input.controllerAllowed);
        if (!current?.routingEnabled || current.revision !== config.revision) continue;
        const revision = await this.input.revision(repository.path);
        if (!revision) continue;
        const report = buildResourceReport({ projectId: config.projectId, endpointId: this.input.network.endpointId,
          repositoryId: repository.id, revision, policyRevision: config.revision, routingEnabled: true,
          revisions: await this.input.revisions?.(repository.path),
          os: this.input.os, architecture: this.input.architecture,
          hardware: { ...hardware, availableDiskBytes: await this.input.disk(repository.path) },
          tools, readyProviders: providers, catalog, now });
        const publish = this.input.publish ?? publishPeerResources;
        for (let from = 0; from < config.peers.length; from += 4) {
          const granted = this.input.network.current(config.projectId, this.input.controllerAllowed);
          const bound = this.input.repository(config.projectId);
          if (!this.input.enabled() || !this.input.online() || !granted?.routingEnabled
            || granted.revision !== config.revision || bound?.id !== repository.id || bound.path !== repository.path) break;
          await Promise.allSettled(config.peers.slice(from, from + 4).map(peer => publish(this.input.config, peer, report)));
        }
      }
    } finally { this.busy = false; }
  }
}
