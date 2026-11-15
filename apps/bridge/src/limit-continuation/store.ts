import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir, writePrivateFile } from '../config';
import { NativeQueueScope } from '../task-dispatch/sender/store';

const MessageId = z.string().min(1).max(180);
const Scheduled = z.object({ resetsAt: z.number().int(), messageId: MessageId, scope: NativeQueueScope,
  /** When this computer queued it; only an account reading taken later speaks for the refusal. */
  scheduledAt: z.number().int().nonnegative().optional(),
  /** The continuation queued at once because a reading showed the window had room before its reset. */
  early: MessageId.optional() }).strict();
export type ScheduledContinuation = z.infer<typeof Scheduled>;
const State = z.object({
  /** Chats the person told not to continue by themselves. */
  off: z.array(z.string().min(1).max(180)).max(4_096),
  /** Continuations this computer put on the relay, by chat. */
  scheduled: z.record(z.string(), Scheduled),
  /** The limit, by chat, an early continuation was already tried for; it is tried once per limit. */
  tried: z.record(z.string(), z.number().int()).optional(),
}).strict();
export type LimitContinuationState = z.infer<typeof State>;

const path = () => join(configDir(), 'limit-continuation.json');

export function readLimitContinuationState(): LimitContinuationState {
  try { return State.parse(JSON.parse(readFileSync(path(), 'utf8'))); }
  catch { return { off: [], scheduled: {} }; }
}

export function writeLimitContinuationState(state: LimitContinuationState): void {
  const tried = Object.entries(state.tried ?? {}).slice(-4_096);
  writePrivateFile(path(), JSON.stringify(State.parse({ off: [...new Set(state.off)].sort().slice(-4_096),
    scheduled: state.scheduled, ...(tried.length ? { tried: Object.fromEntries(tried) } : {}) })));
}
