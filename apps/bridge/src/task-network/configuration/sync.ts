import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { TaskNetworkStore } from '../index';
import { networkRequest, TaskNetworkHttpError } from '../transport/http';
import { decodeProjectConfiguration, projectConfigurationId } from './ciphertext';

type Options = { config: PeerConfig; store: TaskNetworkStore; controllers: () => string[];
  controllerAllowed: (key: string) => boolean; projectAllowed: (id: string) => boolean;
  allowNativeIssuer?: boolean; request?: typeof networkRequest; now?: () => number };

/** Fresh permission must be obtained before automatic work; failed HTTP is never permission. */
export class ProjectConfigurationSync {
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly retryAt = new Map<string, number>();
  constructor(private readonly input: Options) {}

  refresh(projectId: string, options: { background?: boolean } = {}): Promise<boolean> {
    const previous = this.pending.get(projectId);
    if (previous) return previous;
    const now = () => (this.input.now ?? Date.now)();
    if (options.background && (this.retryAt.get(projectId) ?? 0) > now()) return Promise.resolve(false);
    const task = this.fetch(projectId).then(accepted => {
      this.defer(projectId, accepted ? 0 : now() + 15 * 60_000);
      return accepted;
    }).catch(error => {
      this.defer(projectId, now() + (error instanceof TaskNetworkHttpError && error.status === 404
        ? 15 * 60_000 : 60_000));
      return false;
    }).finally(() => this.pending.delete(projectId));
    this.pending.set(projectId, task);
    return task;
  }

  private defer(projectId: string, until: number): void {
    this.retryAt.delete(projectId);
    if (!until) return;
    if (this.retryAt.size >= 128) this.retryAt.delete(this.retryAt.keys().next().value!);
    this.retryAt.set(projectId, until);
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
