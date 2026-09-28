import type { SessionState } from "../../../../../../../packages/protocol/schema";
import { LIVE_MS, stateFor, ts } from "../../../support/common";

export type CodexTurnClock = { startedAt?: number; endedAt?: number };

/** Native turn events distinguish a running tool wait from a completed answer. */
export function observeCodexTurn(row: any, clock: CodexTurnClock): void {
  const at = ts(row.timestamp);
  if (!at) return;
  const payload = row.payload ?? {};
  if (row.type === "event_msg") {
    if (["task_started", "turn_started"].includes(payload.type)) {
      clock.startedAt = Math.max(clock.startedAt ?? 0, at);
    }
    if (["task_complete", "turn_complete", "turn_aborted"].includes(payload.type)) {
      clock.endedAt = Math.max(clock.endedAt ?? 0, at);
    }
  }
  if (row.type !== "response_item") return;
  if (payload.type === "message" && payload.role === "assistant" && payload.channel === "final") {
    clock.endedAt = Math.max(clock.endedAt ?? 0, at);
  } else if (["function_call", "custom_tool_call", "local_shell_call", "reasoning"].includes(payload.type)
    || (payload.type === "message" && payload.role === "assistant"
      && ["analysis", "commentary"].includes(payload.channel))) {
    // A bounded tail may start after the turn-start row. Concrete work is a
    // new observation; a queued user message or token accounting is not.
    clock.startedAt = Math.max(clock.startedAt ?? 0, at);
  }
}

export function codexTurnState(clock: CodexTurnClock, lastActivityAt: number): SessionState {
  if ((clock.endedAt ?? 0) >= (clock.startedAt ?? 0) && clock.endedAt) return "idle";
  if (clock.startedAt && Date.now() - lastActivityAt <= LIVE_MS) return "working";
  return stateFor(lastActivityAt);
}
