import {stateFor} from '../../../support/common';
import type {SessionInfo} from '../../../../../../../packages/protocol/schema';
import {observeClaudeWaits, type ClaudeWaits} from './waits';
export {claudeWaits, type ClaudeWaits} from './waits';

/**
 * `compactQueued`: Claude queued a typed `/compact`, whose dequeue row starts no turn either.
 * `beforeQueue`: whether the turn had ended when the first of the rows queued now came, and `queued`
 * how many are queued; a queued row Claude removes again without a turn leaves the chat as it was.
 */
export type ClaudeTurnClock = {turnEnded?: boolean; compactQueued?: boolean; beforeQueue?: boolean; queued?: number}
  & ClaudeWaits;
const finished = new Set(['end_turn','stop_sequence','max_tokens']);

const LOCAL_COMMAND = /^\s*(?:<local-command-stdout>|<local-command-caveat>|<command-name>\/compact<\/command-name>)/;

/**
 * What Claude Code writes when a command runs in it rather than goes to the model: `/compact`, its
 * summary and its output. These start no turn, so a chat compacted between turns stays idle.
 */
function localCommandRow(row: any): boolean {
  if (row.isCompactSummary === true) return true;
  const content = row.message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.find((block: any) => block?.type === 'text')?.text : undefined;
  return typeof text === 'string' && LOCAL_COMMAND.test(text);
}

/** A `/compact` Claude queued from `claude -p`, and the dequeue right after it. */
function localQueueRow(row: any, clock: ClaudeTurnClock): boolean {
  if (row.operation === 'enqueue') {
    clock.compactQueued = typeof row.content === 'string' && /^\s*\/compact(?:\s|$)/.test(row.content);
    return clock.compactQueued;
  }
  const queued = clock.compactQueued === true;
  clock.compactQueued = false;
  return queued && row.operation === 'dequeue';
}

/**
 * A queued row Claude removed without starting a turn: a background command's notification a subagent
 * took (`absorbed_mid_turn`) or a prompt taken back. Once nothing is queued, the chat is as it was before
 * the first of them; until 0.8.204 such a pair left a finished turn looking unfinished, which hid the
 * background agents it waited on, so the chat looked free while they worked.
 */
function removedQueueRow(row: any, clock: ClaudeTurnClock): boolean {
  if (row.operation === 'enqueue') {
    if (!clock.queued) clock.beforeQueue = clock.turnEnded;
    clock.queued = (clock.queued ?? 0) + 1;
    return false;
  }
  clock.queued = Math.max(0, (clock.queued ?? 0) - 1);
  if (row.operation !== 'remove') { clock.beforeQueue = undefined; return false; }
  if (clock.queued === 0 && clock.beforeQueue !== undefined) clock.turnEnded = clock.beforeQueue;
  if (clock.queued === 0) clock.beforeQueue = undefined;
  return true;
}

/** Root turn boundaries only; progress and sidechain records cannot resume a finished turn. */
export function observeClaudeTurn(row: any, clock: ClaudeTurnClock): void {
  if (row.isSidechain === true) return;
  if (row.type === 'user' && localCommandRow(row)) return;
  if (row.type === 'queue-operation' && localQueueRow(row, clock)) return;
  if (row.type === 'queue-operation' && removedQueueRow(row, clock)) { observeClaudeWaits(row, clock); return; }
  // A turn's own rows settle the queue: Claude does not always write a dequeue for what it took.
  if (row.type === 'user' || row.type === 'assistant') { clock.beforeQueue = undefined; clock.queued = 0; }
  if (row.type === 'user' || row.type === 'queue-operation') clock.turnEnded = false;
  else if (row.type === 'assistant') clock.turnEnded = finished.has(row.message?.stop_reason);
  observeClaudeWaits(row, clock);
}

export function claudeTurnState(clock: ClaudeTurnClock, lastActivityAt: number,
  fallback: SessionInfo['state']): SessionInfo['state'] {
  return clock.turnEnded === undefined ? fallback : clock.turnEnded ? 'idle' : stateFor(lastActivityAt);
}

/** Replaces what an older reading said the chat was waiting on with what this one says. */
export function withClaudeWaits(session: SessionInfo, waits: Pick<SessionInfo, 'backgroundTasks' | 'usageLimit'>): SessionInfo {
  const {backgroundTasks: _background, usageLimit: _limit, ...rest} = session;
  return {...rest, ...waits};
}
