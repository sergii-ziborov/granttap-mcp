/** Which limit stopped the chat, as a person reads it. */
function windowName(window: string | undefined): string {
  if (window === 'five_hour') return '5-hour limit';
  if (window === 'seven_day') return 'weekly limit';
  const model = /^seven_day_([a-z0-9]+)$/.exec(window ?? '')?.[1];
  return model ? `weekly ${model} limit` : window ? `${window} limit` : 'subscription limit';
}

/** A time in the monitor log: UTC to the minute, the way the relay schedules it. */
export function logTime(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * One line in the monitor log for a continuation that was queued, queued again, delivered, skipped or
 * expired. It names the chat by the start of its id and the limit by its kind, never the chat's words.
 */
export function logContinuation(limit: { sessionId: string; window?: string; resetsAt?: number }, event: string): void {
  const which = limit.resetsAt === undefined ? ''
    : ` after its ${windowName(limit.window)} (reset ${logTime(limit.resetsAt)})`;
  process.stderr.write(`[monitor] Continuation of chat ${limit.sessionId.slice(0, 8)}${which}: ${event}.\n`);
}

/** The saved continuations could not be read or written; nothing was queued or taken back this time. */
export function logContinuationsFailure(reason: string): void {
  process.stderr.write(`[monitor] Continuations after subscription limits wait: their state could not be read or saved`
    + ` (${reason}); tried again with the next catalog.\n`);
}
