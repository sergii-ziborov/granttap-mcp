import { limitName, logTime } from '../limit-continuation';
import { CONTINUATION_FIRST_MS, RETRY_AFTER_REFUSAL_MS, type ChatLimit, type HoldReason, type Release } from './decision';

const minutes = (ms: number) => Math.round(ms / 60_000);

function which(limit: ChatLimit): string {
  return limit.resetsAt === undefined ? `its ${limitName(limit.window)} (reset not given)`
    : `its ${limitName(limit.window)} (reset ${logTime(limit.resetsAt)})`;
}

const WHY_HELD: Record<HoldReason, (until: number) => string> = {
  reset: () => 'they go one at a time after the reset',
  continuation: () => 'its continuation goes first',
  'refused-again': until => `the chat was refused again; the next one goes at ${logTime(until)}`,
  'unknown-reset': until => `the next one goes once the account's readings show room, at ${logTime(until)} at the latest`,
};

const WHY_RELEASED: Record<Release, string> = {
  'went-on': 'the chat went on without the limit',
  trying: 'one went to the chat',
  continued: 'its continuation went first',
  reset: 'the limit reset',
  readings: "the account's readings show room",
  retry: `trying again ${minutes(RETRY_AFTER_REFUSAL_MS)} min after the last refusal`,
  'late-continuation': `its continuation did not come within ${minutes(CONTINUATION_FIRST_MS)} min of its time`,
};

/** One line when a usage limit starts holding a chat's queued phone messages. Never the chat's words. */
export function logQueueHeld(sessionId: string, limit: ChatLimit, reason: HoldReason, until: number): void {
  process.stderr.write(`[monitor] Queued messages for chat ${sessionId.slice(0, 8)} wait for ${which(limit)}:`
    + ` ${WHY_HELD[reason](until)}.\n`);
}

/** One line when they may go again. */
export function logQueueReleased(sessionId: string, limit: ChatLimit | undefined, release: Release): void {
  process.stderr.write(`[monitor] Queued messages for chat ${sessionId.slice(0, 8)} go on`
    + `${limit ? ` after ${which(limit)}` : ''}: ${WHY_RELEASED[release]}.\n`);
}

/** The saved holds could not be read or written; the queue waits for the next pass. */
export function logQueueHoldFailure(reason: string): void {
  process.stderr.write(`[monitor] Queued messages behind usage limits wait: their state could not be read or saved`
    + ` (${reason}); tried again shortly.\n`);
}
