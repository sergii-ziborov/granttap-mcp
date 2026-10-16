import { createHash, randomBytes } from 'node:crypto';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { sealEnvelope } from '../../../../../packages/core/relay-client';
import { requestTaskJob, type TaskJobReceipt } from '../../../../../packages/core/task-job-http';
import { TaskDispatch, UserMessage } from '../../../../../packages/protocol/schema';
import { digest } from '../journal';
import { NativeQueueScope, NativeTaskQueueStore } from './store';
export type { NativeQueueScope } from './store';

/** Authenticated same-user IPC creates self-addressed jobs without adding a controller pairing. */
export class NativeTaskQueueSender {
  private readonly store: NativeTaskQueueStore;
  private replaying = false;
  constructor(private readonly options: { root: string; config: PeerConfig; request?: typeof fetch }) {
    this.store = new NativeTaskQueueStore(options.root, options.config);
  }

  async submit(scope: NativeQueueScope, operation: UserMessage, notBefore: number, createdAt: number,
    deliveryMode?: TaskDispatch['deliveryMode']): Promise<TaskJobReceipt> {
    scope = NativeQueueScope.parse(scope); operation = UserMessage.parse(operation);
    if (!operation.messageId || operation.sessionId !== scope.sessionId || operation.projectId !== scope.projectId
      || operation.agent !== scope.provider) throw new Error('Queued Task scope mismatch.');
    const expiresAt = Math.min(createdAt + 30 * 86_400_000, notBefore + 7 * 86_400_000);
    const header = { id: operation.messageId, scope, createdAt, notBefore, expiresAt,
      intent: digest({ scope, operation, notBefore, createdAt, deliveryMode }) };
    this.store.stage(header, () => this.encrypt(scope, operation, notBefore, createdAt, expiresAt, deliveryMode));
    return this.store.uploaded(header.id) ? this.status(scope, header.id) : this.upload(header.id);
  }

  async status(scope: NativeQueueScope, id: string): Promise<TaskJobReceipt> {
    this.store.header(id, scope);
    const receipt = await requestTaskJob(this.options.config, { id, method: 'GET' }, this.options.request);
    if (!receipt) throw new Error('Relay queue status is unavailable.');
    this.retireIfTerminal(receipt);
    return receipt;
  }

  /** Positive durable admission, independent of an ambiguous HTTP response; never inferred provider usage. */
  hasStaged(scope: NativeQueueScope, operation: UserMessage, notBefore: number, createdAt: number,
    deliveryMode?: TaskDispatch['deliveryMode']): boolean {
    try {
      scope = NativeQueueScope.parse(scope); operation = UserMessage.parse(operation);
      if (!operation.messageId) return false;
      const header = this.store.header(operation.messageId, scope);
      return header.intent === digest({ scope, operation, notBefore, createdAt, deliveryMode });
    } catch { return false; }
  }

  async cancel(scope: NativeQueueScope, id: string): Promise<TaskJobReceipt> {
    this.store.header(id, scope);
    if (!this.store.uploaded(id)) await this.upload(id);
    const current = await this.status(scope, id);
    if (['accepted', 'completed', 'cancelled', 'expired'].includes(current.state)) return current;
    const receipt = await requestTaskJob(this.options.config, { id, method: 'DELETE' }, this.options.request);
    if (!receipt) throw new Error('Relay has not confirmed cancellation.');
    this.retireIfTerminal(receipt);
    return receipt;
  }

  async retryPending(): Promise<void> {
    if (this.replaying) return;
    this.replaying = true;
    try {
      for (const id of this.store.pending()) {
        try { await this.upload(id); } catch { break; }
      }
    } finally { this.replaying = false; }
  }

  confirmReceiverOutcome(job: TaskDispatch): void {
    if (job.origin !== 'computer') return;
    try {
      const header = this.store.header(job.jobId);
      if (header.scope.sessionId === job.sessionId && header.scope.projectId === job.operation.projectId) {
        this.store.confirm(job.jobId);
        this.store.retire(job.jobId);
      }
    } catch { /* An externally created self-addressed job has no local sender body. */ }
  }

  private async upload(id: string): Promise<TaskJobReceipt> {
    const record = this.store.record(id);
    const receipt = await requestTaskJob(this.options.config, { id, method: 'PUT', body: record.body }, this.options.request);
    if (!receipt) throw new Error('Relay has not confirmed the queued task.');
    this.store.confirm(id); this.retireIfTerminal(receipt);
    return receipt;
  }

  private encrypt(scope: NativeQueueScope, operation: UserMessage, notBefore: number, createdAt: number,
    expiresAt: number, deliveryMode?: TaskDispatch['deliveryMode']) {
    const job = TaskDispatch.parse({ type: 'task.dispatch', origin: 'computer', jobId: operation.messageId,
      token: randomBytes(32).toString('hex'), sessionId: scope.sessionId, operation, notBefore, expiresAt, createdAt,
      deliveryMode });
    const envelope = JSON.parse(sealEnvelope({ ...this.options.config, role: 'phone',
      peerPublicKey: this.options.config.myPublicKey }, job, 'machine', {
      recipientRouting: true, deliveryId: job.jobId, ttlMs: expiresAt - Date.now() }));
    envelope.expiresAt = expiresAt;
    return { header: { id: job.jobId, scope, createdAt, notBefore, expiresAt,
      intent: digest({ scope, operation, notBefore, createdAt, deliveryMode }) },
      body: { notBefore, expiresAt, acceptanceHash: createHash('sha256').update(job.token).digest('hex'), envelope } };
  }

  private retireIfTerminal(receipt: TaskJobReceipt): void {
    if (['completed', 'cancelled', 'expired'].includes(receipt.state)) this.store.retire(receipt.id);
  }
}
