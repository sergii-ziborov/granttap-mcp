import { createHash, randomUUID } from 'node:crypto';
import type { PeerConfig } from '../../../../packages/core/relay-client';
import type { SessionsStatus } from '../../../../packages/protocol/schema';
import { sealWithTransferKey } from '../../../../packages/core/crypto';
import { taskActivitySnapshot } from './presentation';
import { activitySubscription } from './subscription';
import { activityHTTP, type ActivityHTTP } from './transport';

export type ActivityPublisherOptions = {config: PeerConfig; catalog: () => SessionsStatus | null | undefined;
  isLeader: () => boolean; peerAllowed: (key: string) => boolean; http?: ActivityHTTP; now?: () => number};

/** A separate single-flight lane consumes the published catalog; it never discovers providers. */
export class TaskActivityPublisher {
  private pending?: Promise<void>;
  private closed = false;
  private readonly receipts = new Map<string, {fingerprint: string; sentAt: number}>();
  private readonly http: ActivityHTTP;
  constructor(private readonly options: ActivityPublisherOptions) { this.http = options.http ?? activityHTTP(options.config); }

  tick(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.publish().catch(() => {}).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  close(): void { this.closed = true; this.receipts.clear(); }

  private active(): boolean { return !this.closed && this.options.isLeader(); }

  private async publish(): Promise<void> {
    if (!this.active() || !this.options.config.pushAuth) return;
    const now = (this.options.now ?? Date.now)();
    const catalog = this.options.catalog();
    if (!catalog || !Number.isFinite(catalog.generatedAt) || catalog.generatedAt > now + 30_000
      || now - catalog.generatedAt > 90_000) return;
    const result = await this.http('subscriptions') as {subscriptions?: unknown[]} | null;
    if (!Array.isArray(result?.subscriptions) || result.subscriptions.length > 8) return;
    const active = new Set<string>();
    for (const record of result.subscriptions) {
      if (!this.active()) return;
      const subscription = activitySubscription(this.options.config, record, this.options.peerAllowed, now);
      if (!subscription) continue;
      active.add(subscription.activityId);
      const snapshot = taskActivitySnapshot(catalog, subscription);
      const fingerprint = createHash('sha256').update(JSON.stringify({...snapshot, generatedAt: 0})).digest('hex');
      const prior = this.receipts.get(subscription.activityId);
      if (prior && (now - prior.sentAt < 15_000
        || prior.fingerprint === fingerprint && now - prior.sentAt < 60_000)) continue;
      const event = snapshot.taskCount === 0 ? 'end' : 'update';
      const contentState = sealWithTransferKey(snapshot, subscription.key);
      if (!this.active() || !this.options.peerAllowed(subscription.peerPublicKey)) continue;
      const delivered = await this.http('update', {activityId: subscription.activityId, deliveryId: randomUUID(),
        event, staleDate: Math.floor((catalog.generatedAt + 90_000) / 1_000), contentState}) as
        {accepted?: boolean; closed?: boolean} | null;
      if (delivered?.accepted) this.receipts.set(subscription.activityId, {fingerprint, sentAt: now});
      if (delivered?.closed) this.receipts.delete(subscription.activityId);
    }
    for (const id of this.receipts.keys()) if (!active.has(id)) this.receipts.delete(id);
  }
}
