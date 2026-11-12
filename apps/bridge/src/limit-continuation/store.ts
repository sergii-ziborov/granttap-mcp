import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir, writePrivateFile } from '../config';
import { NativeQueueScope } from '../task-dispatch/sender/store';

const Scheduled = z.object({ resetsAt: z.number().int(), messageId: z.string().min(1).max(180), scope: NativeQueueScope }).strict();
export type ScheduledContinuation = z.infer<typeof Scheduled>;
const State = z.object({
  /** Chats the person told not to continue by themselves. */
  off: z.array(z.string().min(1).max(180)).max(4_096),
  /** Continuations this computer put on the relay, by chat. */
  scheduled: z.record(z.string(), Scheduled),
}).strict();
export type LimitContinuationState = z.infer<typeof State>;

const path = () => join(configDir(), 'limit-continuation.json');

export function readLimitContinuationState(): LimitContinuationState {
  try { return State.parse(JSON.parse(readFileSync(path(), 'utf8'))); }
  catch { return { off: [], scheduled: {} }; }
}

export function writeLimitContinuationState(state: LimitContinuationState): void {
  writePrivateFile(path(), JSON.stringify(State.parse({ off: [...new Set(state.off)].sort().slice(-4_096),
    scheduled: state.scheduled })));
}
