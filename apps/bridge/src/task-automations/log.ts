/** A time in the monitor log: UTC to the minute. */
export function logTime(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * One monitor log line for a run or a skip. It names the automation and its chat by the start of their
 * ids and never their words: not the automation's name, not its message.
 */
export function automationLine(row: { id: string; sessionId: string }, event: string, dueAt?: number, reason?: string): string {
  const due = dueAt === undefined ? '' : ` (due ${logTime(dueAt)})`;
  const why = reason ? `: ${reason.replace(/[.\s]+$/, '')}` : '';
  return `[monitor] Automation ${row.id.replace(/^gta-/, '').slice(0, 8)} in chat ${row.sessionId.slice(0, 8)}: ${event}${due}${why}.`;
}
