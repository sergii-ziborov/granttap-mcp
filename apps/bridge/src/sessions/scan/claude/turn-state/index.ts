import {stateFor} from '../../../support/common';
import type {SessionInfo} from '../../../../../../../packages/protocol/schema';

export type ClaudeTurnClock = {turnEnded?: boolean};
const finished = new Set(['end_turn','stop_sequence','max_tokens']);

/** Root turn boundaries only; progress and sidechain records cannot resume a finished turn. */
export function observeClaudeTurn(row: any, clock: ClaudeTurnClock): void {
  if (row.isSidechain === true) return;
  if (row.type === 'user' || row.type === 'queue-operation') clock.turnEnded = false;
  else if (row.type === 'assistant') clock.turnEnded = finished.has(row.message?.stop_reason);
}

export function claudeTurnState(clock: ClaudeTurnClock, lastActivityAt: number,
  fallback: SessionInfo['state']): SessionInfo['state'] {
  return clock.turnEnded === undefined ? fallback : clock.turnEnded ? 'idle' : stateFor(lastActivityAt);
}
