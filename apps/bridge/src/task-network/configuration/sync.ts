import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { TaskNetworkStore } from '../index';
import { networkRequest } from '../transport/http';
import { decodeProjectConfiguration, projectConfigurationId } from './ciphertext';

type Options = { config: PeerConfig; store: TaskNetworkStore; controllers: () => string[];
  controllerAllowed: (key: string) => boolean; projectAllowed: (id: string) => boolean;
  allowNativeIssuer?: boolean; request?: typeof networkRequest };

/** Fresh permission must be obtained before automatic work; failed HTTP is never permission. */
export class ProjectConfigurationSync {
  private readonly pending = new Map<string, Promise<boolean>>();
  constructor(private readonly input: Options) {}

  refresh(projectId: string): Promise<boolean> {
    const previous = this.pending.get(projectId);
    if (previous) return previous;
    const task = this.fetch(projectId).catch(() => false).finally(() => this.pending.delete(projectId));
    this.pending.set(projectId, task);
    return task;
  }

  private async fetch(projectId: string): Promise<boolean> {
    const { config, store } = this.input;
    const id = projectConfigurationId(projectId, store.endpointId);
    const raw = await (this.input.request ?? networkRequest)({ ...config, credential: config.pushAuth ?? '',
      path: `/task-job-configurations/${id}`, method: 'GET', maxResponseBytes: 100_000 }) as
      { configuration?: unknown } | null;
    const decoded = decodeProjectConfiguration(raw?.configuration, { config, endpointId: store.endpointId,
      projectId, controllers: this.input.controllers(), controllerAllowed: this.input.controllerAllowed,
      now: Date.now(), allowNativeIssuer: this.input.allowNativeIssuer });
    return Boolean(decoded && store.configure(decoded.command, decoded.issuer, id =>
      !decoded.command.enabled || this.input.projectAllowed(id)));
  }
}
