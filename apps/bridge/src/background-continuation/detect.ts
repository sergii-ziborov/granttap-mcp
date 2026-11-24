/**
 * Claude Code's own report that it stopped background work, read from a run GrantTap started. Kept apart
 * from `index.ts` so the provider runner reads it without the continuation's queue and settings.
 */
import type { ReplyResult } from '../reply/payload/types';

/**
 * What `claude -p` writes to stderr (checked against Claude Code 2.1.330) when the background agents and
 * commands its last turn left running are still going past its print-mode ceiling, ten minutes by default
 * (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`): it stops them and exits.
 */
const STOPPED = /Background tasks still running (\S[^\n]{0,39}?) after the last turn \([^\n]{0,4000}?\); stopping them\./;

/** `after`: how long after the last turn Claude waited, as Claude wrote it ("10m"). */
export type StoppedWork = { after: string };

export function stoppedBackgroundWork(stderr: string): StoppedWork | undefined {
  const match = STOPPED.exec(stderr);
  return match ? { after: match[1]!.trim() } : undefined;
}

/** Told about a chat whose background work Claude stopped, at the time the run ended. */
export type StoppedWorkHandler = (sessionId: string, stopped: StoppedWork, at: number) => void;
let handler: StoppedWorkHandler | undefined;

/** Only the persistent monitor continues chats; a chat's own MCP registers nothing. */
export function registerStoppedWorkHandler(next: StoppedWorkHandler | undefined): void { handler = next; }

/**
 * A provider run has ended and its answer is this monitor's to send. When Claude stopped background work
 * the run's turn left running, the registered handler is told which chat it was. `key` is the run's
 * in-flight key: the chat itself, or a new task whose id its answer carries. A moved Task's turn is left
 * alone: its transfer record says where it goes on.
 */
export function noteProviderRunEnded(run: { key?: string; stderr: string; result: ReplyResult }, now = Date.now()): void {
  if (!handler || !run.key) return;
  const stopped = stoppedBackgroundWork(run.stderr);
  if (!stopped) return;
  const sessionId = run.key.startsWith('__new_') ? (run.result.ok ? run.result.sessionId : undefined) : run.key;
  if (!sessionId || sessionId.startsWith('transfer-')) return;
  try { handler(sessionId, stopped, now); }
  catch { /* A continuation that cannot be queued leaves the run's own answer as it is. */ }
}
