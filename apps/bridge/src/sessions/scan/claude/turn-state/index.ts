import {stateFor} from '../../../support/common';
import type {SessionInfo} from '../../../../../../../packages/protocol/schema';
import {observeClaudeWaits, type ClaudeWaits} from './waits';
export {claudeWaits, type ClaudeWaits} from './waits';

export type ClaudeTurnClock = {turnEnded?: boolean} & ClaudeWaits;
const finished = new Set(['end_turn','stop_sequence','max_tokens']);

/** Root turn boundaries only; progress and sidechain records cannot resume a finished turn. */
export function observeClaudeTurn(row: any, clock: ClaudeTurnClock): void {
  if (row.isSidechain === true) return;
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
