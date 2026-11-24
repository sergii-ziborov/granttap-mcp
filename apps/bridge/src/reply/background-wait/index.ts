/**
 * A message from the phone takes its chat back from background work the chat's last turn left running.
 * See README.md.
 */
import type { SessionInfo } from '../../../../../packages/protocol/schema';
import { runKeyFor } from '../in-flight';
import { yieldRun } from '../process';

export { CLAUDE_BACKGROUND_CEILING_MS, withBackgroundCeiling } from './ceiling';

/** Claude Code's own ceiling: how long a waiting message lets the background work go on after the turn. */
export const MESSAGE_WAIT_MS = 600_000;
const NEW_TASK = '__new_claude_task__:';
/** A stopped run takes a moment to exit; it is not signalled again within this. */
const RESTOP_MS = 60_000;
/** When a message was first seen waiting behind each chat's background work, and when its run was stopped. */
const seen = new Map<string, number>();
const stoppedAt = new Map<string, number>();

/** The keys a run's provider process is tracked under: a new task's first run is tracked by its operation key. */
function processKeys(runKey: string): string[] {
  return runKey.startsWith(NEW_TASK) ? [runKey, runKey.slice(NEW_TASK.length)] : [runKey];
}

/**
 * A message from the phone waits for `chatId`, whose run is in flight. When the chat's turn has ended and
 * only background work it left keeps that run going, the run is stopped ten minutes after the turn ended,
 * and never later than ten minutes after the message was first seen waiting. A message so waits no longer
 * than it did when Claude Code stopped that work ten minutes after the turn itself. Returns whether a run
 * was stopped now.
 */
export function messageWaitsBehindRun(chatId: string, session: SessionInfo | undefined, now = Date.now()): boolean {
  const runKey = runKeyFor(chatId);
  if (!runKey || session?.agent !== 'claude' || !session.backgroundTasks) {
    seen.delete(chatId); stoppedAt.delete(chatId); return false;
  }
  if (now - (stoppedAt.get(chatId) ?? -Infinity) < RESTOP_MS) return false;
  const first = seen.get(chatId) ?? now;
  seen.set(chatId, first);
  const since = Math.min(first, session.lastActivityAt > 0 ? session.lastActivityAt : now);
  if (now - since < MESSAGE_WAIT_MS) return false;
  seen.delete(chatId);
  const stopped = yieldRun(processKeys(runKey), chatId);
  if (stopped === 0) return false;
  stoppedAt.set(chatId, now);
  process.stderr.write(`[monitor] A message waits for chat ${chatId.slice(0, 8)}, whose run only background work its `
    + `turn left kept going; that work was stopped ${Math.round((now - since) / 60_000)} min after the turn.\n`);
  return true;
}
