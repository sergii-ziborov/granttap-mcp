/**
 * How a Codex turn ended when it gave no ordinary answer row.
 *
 * Codex CLI 0.16x writes a turn's end as `event_msg` `task_complete`: its answer in
 * `last_agent_message`, or `null` there and the reason in `error`
 * (`{ message, codex_error_info }`). Its messages also arrive as `item_completed` items
 * (`AgentMessage`, `UserMessage`, and `Extension` for the image tool), beside or instead of
 * the older `response_item` messages. This module reads those rows; the scanner and the
 * transcript reader decide what to show.
 */
import { basename } from "node:path";
import type { SessionInfo, SessionStopped } from "../../../../../../../packages/protocol/schema";
import { ts } from "../../../support/common";

/** The same hour after which a limited chat is shown as simply idle (`claude/turn-state/waits.ts`). */
export const LIMIT_STALE_MS = 3_600_000;

/** What one rollout has said about the end of its newest turn. */
export type CodexOutcome = {
  stopped?: SessionStopped;
  /** When Codex said the usage limit lets the chat go on. */
  resetsAt?: number;
  /** The newest final answer, as Codex wrote it. */
  answer?: string;
  /** The file name Codex's image tool saved its picture as, in this turn. */
  generated?: string;
  /** The newest request carried only by an `item_completed` `UserMessage`. */
  itemRequest?: string;
  /** When the newest turn began, as its own start row says. */
  since?: number;
};

const REASONS: Readonly<Record<string, string>> = {
  usage_limit_exceeded: "usage_limit",
  rate_limit_exceeded: "rate_limit",
  context_window_exceeded: "context_window",
  unauthorized: "sign_in",
  server_overloaded: "service",
  internal_server_error: "service",
  http_connection_failed: "service",
  response_stream_connection_failed: "service",
  response_stream_disconnected: "service",
  response_too_many_failed_attempts: "service",
  flex_unavailable: "service",
  policy_capacity_unavailable: "service",
};

/** Codex names an error by a word, or by an object whose one key is that word. */
function errorCode(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  if (info && typeof info === "object" && !Array.isArray(info)) return Object.keys(info)[0];
  return undefined;
}

/** The kind of stop the phone words for itself; one it does not know is shown by its message. */
export function stopReason(info: unknown): string {
  return REASONS[errorCode(info) ?? ""] ?? "error";
}

/** Codex's own first sentence, without the links and offers after it. */
export function providerSentence(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const plain = message.replace(/\s*\(?\bhttps?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  const first = /^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
  const bounded = Array.from(first).slice(0, 300).join("").trim();
  return bounded || undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RETRY_AT = /try again at (?:([A-Za-z]{3}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ?([AP]M)/i;

/**
 * When Codex said to try again: `4:45 PM` on the day of the error, or `Nov 18th, 2026 4:45 PM`.
 * Codex prints the time in this computer's own zone, and it is read back in the same zone.
 */
export function codexRetryAt(message: unknown, at: number): number | undefined {
  const match = typeof message === "string" ? RETRY_AT.exec(message) : null;
  if (!match || !at) return undefined;
  const [, month, day, year, hour, minute, half] = match as unknown as string[];
  const hours = Number(hour), minutes = Number(minute), monthIndex = MONTHS.indexOf(month?.toLowerCase() ?? "");
  if (hours < 1 || hours > 12 || minutes > 59 || (month && monthIndex < 0)) return undefined;
  const base = new Date(at);
  const date = month ? new Date(Number(year), monthIndex, Number(day))
    : new Date(base.getFullYear(), base.getMonth(), base.getDate());
  date.setHours((hours % 12) + (half!.toUpperCase() === "PM" ? 12 : 0), minutes, 0, 0);
  const value = date.getTime();
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function itemText(item: any): string | undefined {
  const text = (Array.isArray(item?.content) ? item.content : [])
    .filter((block: any) => typeof block?.text === "string" && ["Text", "text", "output_text"].includes(block.type))
    .map((block: any) => block.text as string).join("\n").trim();
  return text || undefined;
}

function endTurn(payload: any, at: number, outcome: CodexOutcome): string | undefined {
  const error = payload.error;
  if (error && typeof error === "object") {
    const message = providerSentence(error.message);
    outcome.stopped = { reason: stopReason(error.codex_error_info), ...(message ? { message } : {}), at: at || 1 };
    outcome.resetsAt = outcome.stopped.reason === "usage_limit" ? codexRetryAt(error.message, at) : undefined;
    return stoppedText(outcome.stopped);
  }
  const answer = typeof payload.last_agent_message === "string" ? payload.last_agent_message.trim() : "";
  if (!answer) return undefined;
  outcome.answer = answer;
  return answer;
}

/**
 * Read one rollout row for how its turn ended. Returns the text the row shows as the chat's
 * newest message, when it carries one the older rows do not: an answer only an item or the
 * turn's end carries, or the stop.
 */
export function observeCodexOutcome(row: any, outcome: CodexOutcome): string | undefined {
  const payload = row?.payload ?? {};
  const at = ts(row?.timestamp);
  if (row?.type === "response_item" && payload.type === "message" && payload.role === "assistant"
    && (payload.phase === "final_answer" || payload.channel === "final")) {
    outcome.answer = itemText(payload) ?? outcome.answer;
    return undefined;
  }
  if (row?.type !== "event_msg") return undefined;
  if (payload.type === "task_started" || payload.type === "turn_started") {
    delete outcome.stopped; delete outcome.resetsAt; delete outcome.answer; delete outcome.generated;
    if (at) outcome.since = at;
    return undefined;
  }
  if (payload.type === "task_complete" || payload.type === "turn_complete") return endTurn(payload, at, outcome);
  if (payload.type !== "item_completed") return undefined;
  const item = payload.item ?? {};
  if (item.type === "UserMessage") outcome.itemRequest = itemText(item) ?? outcome.itemRequest;
  if (item.type === "Extension" && String(item.kind ?? "").startsWith("image_gen")
    && item.status === "completed" && typeof item.savedPath === "string" && item.savedPath) {
    outcome.generated = basename(item.savedPath).slice(0, 256);
  }
  if (item.type !== "AgentMessage") return undefined;
  const text = itemText(item);
  if (text && item.phase === "final_answer") outcome.answer = text;
  return text;
}

/** The chat's newest message when its turn stopped on an error. */
export function stoppedText(stopped: SessionStopped): string {
  return stopped.message ? `Codex stopped: ${stopped.message}` : "Codex stopped.";
}

/** What the session publishes about a stopped turn; a limit that reset over an hour ago is no longer one. */
export function stoppedFields(outcome: CodexOutcome | undefined, now = Date.now()): Pick<SessionInfo, "stopped" | "usageLimit"> {
  if (!outcome?.stopped) return {};
  const limited = outcome.resetsAt && outcome.resetsAt > now - LIMIT_STALE_MS;
  return { stopped: outcome.stopped, ...(limited ? { usageLimit: { resetsAt: Math.round(outcome.resetsAt!) } } : {}) };
}

/** A cached session read again later: its limit may have gone stale meanwhile. */
export function withCurrentLimit(session: SessionInfo, now = Date.now()): SessionInfo {
  if (!session.usageLimit || session.usageLimit.resetsAt > now - LIMIT_STALE_MS) return session;
  const { usageLimit: _stale, ...rest } = session;
  return rest;
}
