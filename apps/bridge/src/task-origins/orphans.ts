/**
 * A follow-up written into a new task that never started on this computer.
 *
 * The phone sends a message typed into a chat it has not heard back about yet as
 * `user.message.continue`, naming the new task's own message. It waits here until that task's
 * creation is on record (`TaskOriginRegistry`). A new task refused before its provider started left
 * no record up to 0.8.207, and one lost to a full disk or a crash still leaves none: the follow-up
 * then waited for its thirty days, and the phone said "Saved on relay" the whole time.
 *
 * Now, once such a follow-up has waited here for `ORPHAN_GRACE_MS`, the relay is asked about the
 * task's own message. While that message is still queued or being taken there, the task can still
 * come and the follow-up keeps waiting. Otherwise the follow-up is refused with `ORPHAN_REASON`, which
 * the phone shows under it. The relay is asked at most every `ORPHAN_LOOKUP_MS` per task.
 */
import type { TaskDispatch } from '../../../../packages/protocol/schema';
import type { TaskOriginRegistry } from './index';

export const ORPHAN_GRACE_MS = 30 * 60_000;
export const ORPHAN_LOOKUP_MS = 10 * 60_000;
/** The relay records only its own fixed result codes; the reason reaches the phone in a receipt. */
export const ORPHAN_CODE = 'delivery_failed';
export const ORPHAN_REASON = 'This message was written for a new task that never started on this computer, '
  + 'so it has no chat to go to. Send the task again from a new chat.';

/** The relay states of a message that can still reach this computer. */
const STILL_COMING = new Set(['queued', 'accepted']);

type Lookup = { at: number; running?: Promise<void>; settled?: boolean };

export class OrphanFollowUps {
  private readonly lookups = new Map<string, Lookup>();
  private readonly now: () => number;
  constructor(private readonly options: {
    registry: TaskOriginRegistry;
    /** The relay state of a queued message by its ID; `expired` when the relay has no such job. */
    relayState: (jobId: string) => Promise<string>;
    now?: () => number;
    onError?: (error: unknown) => void;
  }) {
    this.now = options.now ?? Date.now;
  }

  /**
   * True once this follow-up's task is known never to start here. A lookup that is due starts in
   * the background; its answer is read on a later pass.
   */
  orphaned(job: TaskDispatch, scope: { room: string; peerPublicKey: string }, stagedAt: number): boolean {
    const operation = job.operation;
    if (operation.type !== 'user.message.continue') return false;
    const origin = { ...scope, originMessageId: operation.originMessageId };
    // Any record, even a creation still running or a failed one, is the registry's to answer.
    if (this.now() - stagedAt < ORPHAN_GRACE_MS || this.options.registry.recorded(origin)) return false;
    const key = `${scope.room}\n${scope.peerPublicKey}\n${operation.originMessageId}`;
    const lookup = this.lookups.get(key);
    if (lookup?.settled) return true;
    if (lookup?.running || (lookup && this.now() - lookup.at < ORPHAN_LOOKUP_MS)) return false;
    const next: Lookup = { at: this.now() };
    next.running = this.options.relayState(operation.originMessageId).then(state => {
      // A creation that began while the relay was asked is on record now and wins.
      next.settled = !STILL_COMING.has(state) && !this.options.registry.recorded(origin);
    }).catch(error => { this.options.onError?.(error); }).finally(() => { next.running = undefined; });
    this.lookups.set(key, next);
    return false;
  }
}
