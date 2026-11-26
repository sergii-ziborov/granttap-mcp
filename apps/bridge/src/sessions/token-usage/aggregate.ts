import type {
  TokenUsage,
  TokenUsageChat,
  TokenUsageHour,
  TokenUsageModel,
  TokenUsageWindow,
} from "../../../../../packages/protocol/schema";
import { HOUR_MS, hourStart, tokenModelName, type TokenHour } from "./hours";

export const TOKEN_USAGE_WINDOW_HOURS = [24, 168, 720] as const;
export const MAX_TOKEN_USAGE_CHATS = 12;
export const MAX_TOKEN_USAGE_MODELS = 16;
/** The last day's hours, the current one included. */
export const MAX_TOKEN_USAGE_HOURS = 25;

/** One chat's hours, as its provider reader keeps them, with what the chat itself says. */
export type SessionTokenHours = {
  agent: string;
  sessionId: string;
  /** The chat's model, for turns that did not name one. */
  model?: string;
  /** Where turns without a time of their own are counted. */
  lastActivityAt: number;
  hours: readonly TokenHour[];
};

type Tally = { tokens: number; chats: Map<string, { chat: SessionTokenHours; tokens: number; model?: string }>;
  models: Map<string, { agent: string; model: string; tokens: number }> };

function heaviest<T extends { tokens: number }>(rows: Iterable<T>, limit: number, key: (row: T) => string): T[] {
  return [...rows].filter((row) => Math.round(row.tokens) > 0)
    .sort((left, right) => right.tokens - left.tokens || key(left).localeCompare(key(right)))
    .slice(0, limit);
}

function countTurn(tally: Tally, chat: SessionTokenHours, row: TokenHour): void {
  tally.tokens += row.tokens;
  const chatKey = `${chat.agent}\0${chat.sessionId}`;
  const model = tokenModelName(row.model) ?? tokenModelName(chat.model);
  const known = tally.chats.get(chatKey) ?? { chat, tokens: 0 };
  known.tokens += row.tokens;
  known.model = model ?? known.model;
  tally.chats.set(chatKey, known);
  if (!model) return;
  const modelKey = `${chat.agent}\0${model}`;
  const spent = tally.models.get(modelKey) ?? { agent: chat.agent, model, tokens: 0 };
  spent.tokens += row.tokens;
  tally.models.set(modelKey, spent);
}

function windowOf(windowHours: TokenUsageWindow["windowHours"], tally: Tally): TokenUsageWindow {
  const listed = [...tally.chats.values()].filter((row) => publishable(row.chat.agent, row.chat.sessionId));
  const chats: TokenUsageChat[] = heaviest(listed, MAX_TOKEN_USAGE_CHATS,
    (row) => `${row.chat.agent}\0${row.chat.sessionId}`).map((row) => {
    const model = tokenModelName(row.chat.model) ?? row.model;
    return { sessionId: row.chat.sessionId, agent: row.chat.agent, ...(model ? { model } : {}), tokens: Math.round(row.tokens) };
  });
  const named = [...tally.models.values()].filter((row) => publishable(row.agent));
  const models: TokenUsageModel[] = heaviest(named, MAX_TOKEN_USAGE_MODELS,
    (row) => `${row.agent}\0${row.model}`).map((row) => ({ ...row, tokens: Math.round(row.tokens) }));
  return { windowHours, tokens: Math.round(tally.tokens), chats, models };
}

/** A chat the wire cannot name is not listed, rather than renamed; its spend still counts in the total. */
function publishable(agent: string, sessionId = agent): boolean {
  return sessionId.length >= 1 && sessionId.length <= 256 && agent.length >= 1 && agent.length <= 80;
}

/**
 * What each period spent, from every chat's hourly counts. A period counts the clock hours that start
 * at or after the hour holding `now` minus the period, so it can reach up to an hour further back.
 * A turn timed after `now` (another clock) counts in the current hour.
 */
export function tokenUsageOf(perSession: readonly SessionTokenHours[], now = Date.now()): TokenUsage {
  const current = hourStart(now);
  const since = TOKEN_USAGE_WINDOW_HOURS.map((windowHours) => hourStart(now - windowHours * HOUR_MS));
  const tallies: Tally[] = TOKEN_USAGE_WINDOW_HOURS.map(() => ({ tokens: 0, chats: new Map(), models: new Map() }));
  const hourly = new Map<number, number>();
  for (const chat of perSession) {
    for (const row of chat.hours) {
      if (!Number.isFinite(row.tokens) || row.tokens <= 0) continue;
      const at = Math.min(current, row.startedAt ?? hourStart(chat.lastActivityAt));
      since.forEach((start, index) => { if (at >= start) countTurn(tallies[index]!, chat, row); });
      if (at >= since[0]!) hourly.set(at, (hourly.get(at) ?? 0) + row.tokens);
    }
  }
  const hours: TokenUsageHour[] = [...hourly].map(([startedAt, tokens]) => ({ startedAt, tokens: Math.round(tokens) }))
    .filter((hour) => hour.tokens > 0).sort((left, right) => left.startedAt - right.startedAt)
    .slice(-MAX_TOKEN_USAGE_HOURS);
  return {
    windows: TOKEN_USAGE_WINDOW_HOURS.map((windowHours, index) => windowOf(windowHours, tallies[index]!)),
    hours,
  };
}
