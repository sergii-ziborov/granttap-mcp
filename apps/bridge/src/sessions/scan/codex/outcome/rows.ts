/**
 * The transcript rows newer Codex versions write in place of, or beside, the older messages.
 *
 * `item_completed` `AgentMessage` repeats the `response_item` message that follows it, with the
 * same id. An item is therefore held until its turn ends and shown only when no older message
 * with its id came: transcripts keep the ids they had. The turn's end then shows its answer when
 * no message of the turn did, or the reason the turn stopped. A finished image tool call is shown
 * as a tool row.
 */
import { basename } from "node:path";
import type { ActivityEntry } from "../../../../../../../packages/protocol/schema";
import { pushEntry, type PushEntryInput } from "../../../support/activity-helpers";
import { providerSentence, stopReason, stoppedText } from "./index";

/** Per turn: items waiting for their older message, answers shown, and whether the turn's start was read. */
type TurnMemo = { held: Map<string, PushEntryInput>; shown: Set<string>; started?: boolean };
const memos = new WeakMap<Set<string>, Map<string, TurnMemo>>();

function memoFor(seen: Set<string>, thread: string): TurnMemo {
  let threads = memos.get(seen);
  if (!threads) memos.set(seen, threads = new Map());
  let memo = threads.get(thread);
  if (!memo) threads.set(thread, memo = { held: new Map(), shown: new Set() });
  return memo;
}

function itemText(item: any): string {
  return (Array.isArray(item?.content) ? item.content : [])
    .filter((block: any) => typeof block?.text === "string").map((block: any) => block.text as string).join("\n").trim();
}

export type OutcomeRowInput = {
  out: ActivityEntry[];
  seen: Set<string>;
  sessionId: string;
  thread: string;
  row: any;
  createdAt: number;
  entryId: (at: number, block: number) => string;
  extras: Record<string, unknown>;
  fullText?: boolean;
};

/** An older assistant message was shown: its item is not shown again, nor its text as the turn's answer. */
export function noteCodexMessage(seen: Set<string>, thread: string, payload: any, text: unknown): void {
  const memo = memoFor(seen, thread);
  if (typeof payload?.id === "string") memo.held.delete(payload.id);
  if (typeof text === "string" && text.trim()) memo.shown.add(text.trim());
}

function endTurn(input: OutcomeRowInput, memo: TurnMemo): void {
  const { row, createdAt } = input, payload = row.payload ?? {};
  for (const held of memo.held.values()) {
    pushEntry(held);
    memo.shown.add(String(held.text).trim());
  }
  memo.held.clear();
  const push = (text: string, extras: Record<string, unknown> = {}) => pushEntry({ out: input.out, seen: input.seen,
    sessionId: input.sessionId, kind: "final", text, createdAt, ordinal: 0, extras: { ...input.extras, ...extras },
    idOverride: input.entryId(createdAt, 0), fullText: input.fullText });
  if (payload.error && typeof payload.error === "object") {
    const message = providerSentence(payload.error.message);
    push(stoppedText({ reason: stopReason(payload.error.codex_error_info), ...(message ? { message } : {}), at: createdAt || 1 }),
      { outcome: "error" });
  } else if (memo.started && typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()
    && !memo.shown.has(payload.last_agent_message.trim())) {
    // Only when this read began with the turn: a page that starts mid-turn may have left its answer above.
    push(payload.last_agent_message);
  }
  memo.shown.clear();
  memo.started = false;
}

/** Shows one of the newer rows. Returns whether the row was one of them. */
export function appendCodexOutcomeRow(input: OutcomeRowInput): boolean {
  const { row, createdAt } = input, payload = row?.payload ?? {};
  if (row?.type !== "event_msg") return false;
  const memo = memoFor(input.seen, input.thread);
  if (payload.type === "task_started" || payload.type === "turn_started") {
    memo.held.clear(); memo.shown.clear(); memo.started = true;
    return true;
  }
  if (payload.type === "task_complete" || payload.type === "turn_complete") { endTurn(input, memo); return true; }
  if (payload.type !== "item_completed") return false;
  const item = payload.item ?? {};
  if (item.type === "AgentMessage" && typeof item.id === "string" && itemText(item)) {
    memo.held.set(item.id, { out: input.out, seen: input.seen, sessionId: input.sessionId,
      kind: item.phase === "final_answer" ? "final" : "message", text: itemText(item), createdAt, ordinal: 0,
      extras: input.extras, idOverride: input.entryId(createdAt, 0), fullText: input.fullText });
    return true;
  }
  if (item.type === "Extension" && String(item.kind ?? "").startsWith("image_gen") && item.status === "completed") {
    const name = typeof item.savedPath === "string" && item.savedPath ? basename(item.savedPath).slice(0, 256) : undefined;
    const id = `${input.thread}:${typeof item.id === "string" ? item.id.slice(0, 128) : createdAt}`;
    if (input.seen.has(id)) return true;
    input.seen.add(id);
    input.out.push({ id, kind: "tool", text: name ? `Picture saved: ${name}` : "Picture made", createdAt,
      toolName: "image_gen", outcome: "success", ...input.extras });
    return true;
  }
  return false;
}
