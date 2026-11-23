import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserMessage } from '../../../../packages/protocol/schema';
import { configDir, writePrivateFile } from '../config';
import { NativeQueueScope } from '../task-dispatch/sender/store';

/** The provider's clock and ours differ a little; arriving just before the reset would hit the limit again. */
export const LIMIT_CONTINUE_GRACE_MS = 60_000;
const MessageId = z.string().min(1).max(180);
const Time = z.number().int();

/** One message this computer put, or is still to put, on the relay. Its id is never used for another. */
const Copy = z.object({ messageId: MessageId, notBefore: Time,
  /** The exact message, so a retry after a failure or a restart stages the identical job. */
  message: UserMessage.optional(),
  /** The relay confirmed it holds this copy. */
  onRelay: z.boolean(),
  /** When the monitor let it through to the chat. */
  deliveredAt: Time.optional() }).strict();
export type ContinuationCopy = z.infer<typeof Copy>;

const Job = z.object({ resetsAt: Time, window: z.string().max(40).optional(), scope: NativeQueueScope,
  /** When this computer queued it; only an account reading taken later speaks for the refusal. */
  scheduledAt: Time.nonnegative().optional(),
  /** The chat's last activity when it was last refused. A chat that has not moved since is still held. */
  activityAt: Time.optional(),
  /** Due a minute after the reset. */
  regular: Copy,
  /** Due at once, because a reading showed the window had room before its reset. */
  early: Copy.optional() }).strict();
export type ScheduledContinuation = z.infer<typeof Job>;

/** What monitors up to 0.8.198 wrote: ids only, recorded once the relay had taken them. */
const LegacyJob = z.object({ resetsAt: Time, messageId: MessageId, scope: NativeQueueScope,
  scheduledAt: Time.nonnegative().optional(), early: MessageId.optional() }).strict()
  .transform((job): ScheduledContinuation => ({ resetsAt: job.resetsAt, scope: job.scope,
    ...(job.scheduledAt === undefined ? {} : { scheduledAt: job.scheduledAt }),
    regular: { messageId: job.messageId, notBefore: job.resetsAt + LIMIT_CONTINUE_GRACE_MS, onRelay: true },
    ...(job.early ? { early: { messageId: job.early, notBefore: job.scheduledAt ?? 0, onRelay: true } } : {}) }));

const State = z.object({
  /** Chats the person told not to continue by themselves. */
  off: z.array(z.string().min(1).max(180)).max(4_096),
  /** The continuation waiting for each chat a limit stopped. */
  scheduled: z.record(z.string(), z.union([Job, LegacyJob])),
  /** The limit, by chat, an early continuation was already tried for; it is tried once per limit. */
  tried: z.record(z.string(), Time).optional(),
  /** The reset, by chat, whose continuation was handed over; refused again for it, the next one waits. */
  continued: z.record(z.string(), z.object({ resetsAt: Time, at: Time }).strict()).optional(),
}).strict();
export type LimitContinuationState = z.infer<typeof State>;

const path = () => join(configDir(), 'limit-continuation.json');

/**
 * The saved state; a missing file, or one that is not this state, is empty. A disk that cannot be read
 * throws, so a writer never replaces what it could not see, such as the chats the person turned off.
 */
export function readLimitContinuationState(): LimitContinuationState {
  let raw: string;
  try { raw = readFileSync(path(), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { off: [], scheduled: {} };
    throw error;
  }
  try { return State.parse(JSON.parse(raw)); } catch { return { off: [], scheduled: {} }; }
}

export function writeLimitContinuationState(state: LimitContinuationState): void {
  const tried = Object.entries(state.tried ?? {}).slice(-4_096), continued = Object.entries(state.continued ?? {}).slice(-4_096);
  writePrivateFile(path(), JSON.stringify(State.parse({ off: [...new Set(state.off)].sort().slice(-4_096),
    scheduled: state.scheduled, ...(tried.length ? { tried: Object.fromEntries(tried) } : {}),
    ...(continued.length ? { continued: Object.fromEntries(continued) } : {}) })));
}
