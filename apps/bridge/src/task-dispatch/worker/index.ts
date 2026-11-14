import { randomUUID } from 'node:crypto';
import type { TaskDispatch } from '../../../../../packages/protocol/schema';
import { TaskDispatchInbox, type StoredTaskDispatch } from '../index';

export interface TaskJobRemote {
  get(job: TaskDispatch): Promise<string>;
  claim(job: TaskDispatch, claimId: string): Promise<boolean>;
  finish(job: TaskDispatch, state: 'completed' | 'failed', code?: string, claimId?: string): Promise<void>;
}
export type WorkerOptions = {
  inbox: TaskDispatchInbox; remote: TaskJobRemote;
  onTerminal?: (job: TaskDispatch) => void;
  onError?: (error: unknown) => void;
  connected: () => boolean; authorized: (peer: string) => boolean;
  conversationKey?: (job: TaskDispatch, peer: string) => string;
  validationCode?: (job: TaskDispatch, peer: string) => string | undefined;
  ready: (job: TaskDispatch, peer: string) => boolean;
  deliver: (job: TaskDispatch, beforeStart: () => Promise<void>, peer: string) => Promise<'accepted' | 'rejected'>;
};
class DeferredLaunch extends Error {}
const REFUSED_LOOKUP_MS = 10 * 60_000;

/** Server acceptance follows local fsync. Native submission is never replayed on a lease timer. */
export class TaskDispatchWorker {
  private readonly active = new Map<string, Promise<void>>();
  private readonly conversations = new Set<string>();
  /** When each refused job was last looked up on the relay; it only waits there to be cancelled or to expire. */
  private readonly refusedLookups = new Map<string, number>();
  constructor(private readonly options: WorkerOptions) {}

  async tick(now = Date.now()): Promise<void> {
    if (!this.options.connected()) return;
    const launched: Promise<void>[] = [];
    const records = this.options.inbox.pendingRecords().sort((a, b) =>
      Number(b.job.deliveryMode === 'immediate') - Number(a.job.deliveryMode === 'immediate')
        || a.job.createdAt - b.job.createdAt);
    const keyOf = (record: StoredTaskDispatch) => this.options.conversationKey?.(record.job, record.peerPublicKey)
      ?? record.job.sessionId ?? `new:${record.job.operation.agent ?? 'codex'}`;
    // A refusal is final for its message. It keeps holding the follow-ups that were already queued behind
    // it until the person cancels it; it used to hold every later message of the chat as well, for days.
    const refusedAt = new Map<string, number>();
    for (const record of records) {
      if (record.phase !== 'rejected') continue;
      const key = keyOf(record);
      refusedAt.set(key, Math.max(refusedAt.get(key) ?? -Infinity, record.updatedAt));
      if (!this.active.has(record.job.jobId)) launched.push(this.settleRefused(record, now));
    }
    for (const record of records) {
      if (['completed', 'cancelled', 'rejected'].includes(record.phase) || this.active.has(record.job.jobId)) continue;
      const key = keyOf(record);
      // Staged before the refusal: a follow-up written for the message that failed. Staged after it: the
      // person saw the failure and sent this anyway.
      if (record.stagedAt <= (refusedAt.get(key) ?? -Infinity)) continue;
      if (this.conversations.has(key)) continue;
      this.conversations.add(key);
      const work = this.process(record).catch(error => { this.options.onError?.(error); }).finally(() => {
        this.active.delete(record.job.jobId); this.conversations.delete(key);
      });
      this.active.set(record.job.jobId, work); launched.push(work);
    }
    await Promise.all(launched);
  }

  private async process(record: StoredTaskDispatch): Promise<void> {
    const { inbox, remote } = this.options, { job } = record;
    let claimId = record.claimId;
    if (record.phase === 'delivered' || record.phase === 'failed') return this.finish(record);
    if (record.phase === 'running') {
      if (attemptOwnerAlive(record)) return;
      inbox.transition(job.jobId, 'uncertain', { code: 'confirmation_required' });
      await remote.finish(job, 'failed', 'confirmation_required', claimId);
      inbox.transition(job.jobId, 'rejected');
      this.options.onTerminal?.(job); return;
    }
    if (record.phase === 'uncertain') {
      await remote.finish(job, 'failed', 'confirmation_required', claimId);
      inbox.transition(job.jobId, 'rejected');
      this.options.onTerminal?.(job); return;
    }
    const state = await remote.get(job);
    if (['cancelled', 'expired'].includes(state)) { inbox.transition(job.jobId, 'cancelled'); inbox.retire(job.jobId); return; }
    if (state === 'completed' || state === 'failed') {
      // A server terminal state cannot authorize a new native invocation.
      inbox.transition(job.jobId, 'failed', { code: 'already_finished' });
      inbox.transition(job.jobId, 'completed'); inbox.retire(job.jobId); return;
    }
    if (job.notBefore > Date.now()) return;
    if (!this.options.authorized(record.peerPublicKey)) return this.reject(record, 'policy_denied');
    const validation = this.options.validationCode?.(job, record.peerPublicKey);
    if (validation) return this.reject(record, validation);
    if (!this.options.ready(job, record.peerPublicKey)) return;
    let started = false;
    try {
      const outcome = await this.options.deliver(job, async () => {
        if (!this.options.authorized(record.peerPublicKey)) throw new DeferredLaunch();
        inbox.ensureDurable(job.jobId);
        claimId = inbox.reserveClaim(job.jobId);
        if (!await remote.claim(job, claimId)) throw new DeferredLaunch();
        if (record.phase === 'staged' && !inbox.transition(job.jobId, 'claimed')) throw new DeferredLaunch();
        if (!inbox.transition(job.jobId, 'running', { nativeAttemptId: `${process.pid}:${randomUUID()}` })) {
          throw new DeferredLaunch();
        }
        started = true;
      }, record.peerPublicKey);
      if (!started) { if (outcome === 'rejected') await this.reject(record, 'policy_denied'); return; }
      inbox.transition(job.jobId, outcome === 'accepted' ? 'delivered' : 'failed',
        outcome === 'rejected' ? { code: 'delivery_failed' } : {});
    } catch (error) {
      if (error instanceof DeferredLaunch || !started) return;
      inbox.transition(job.jobId, 'uncertain', { code: 'confirmation_required' });
      await remote.finish(job, 'failed', 'confirmation_required', claimId);
      inbox.transition(job.jobId, 'rejected');
      this.options.onTerminal?.(job); return;
    }
    await this.finish(inbox.get(job.jobId));
  }

  /** A refused job leaves once the relay cancelled or expired it. Asking every two seconds was only load. */
  private async settleRefused(record: StoredTaskDispatch, now: number): Promise<void> {
    const { inbox, remote } = this.options, id = record.job.jobId;
    if (now - (this.refusedLookups.get(id) ?? -Infinity) < REFUSED_LOOKUP_MS) return;
    this.refusedLookups.set(id, now);
    const work = (async () => {
      if (!['cancelled', 'expired'].includes(await remote.get(record.job))) return;
      inbox.transition(id, 'cancelled'); inbox.retire(id); this.refusedLookups.delete(id);
    })().catch(error => { this.options.onError?.(error); }).finally(() => { this.active.delete(id); });
    this.active.set(id, work);
    await work;
  }

  private async reject(record: StoredTaskDispatch, code: string): Promise<void> {
    const claimId = this.options.inbox.reserveClaim(record.job.jobId);
    if (!await this.options.remote.claim(record.job, claimId)) return;
    if (record.phase === 'staged' && !this.options.inbox.transition(record.job.jobId, 'claimed')) return;
    this.options.inbox.transition(record.job.jobId, 'failed', { code });
    await this.finish({ ...record, phase: 'failed', code, claimId });
  }

  private async finish(record: StoredTaskDispatch): Promise<void> {
    await this.options.remote.finish(record.job, record.phase === 'delivered' ? 'completed' : 'failed', record.code, record.claimId);
    this.options.inbox.transition(record.job.jobId, record.phase === 'delivered' ? 'completed' : 'rejected');
    if (record.phase === 'delivered') this.options.inbox.retire(record.job.jobId);
    this.options.onTerminal?.(record.job);
  }
}

function attemptOwnerAlive(record: StoredTaskDispatch): boolean {
  const pid = Number(record.nativeAttemptId?.split(':')[0]);
  if (!Number.isSafeInteger(pid) || pid < 1 || Date.now() - record.updatedAt > 15 * 60_000) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
