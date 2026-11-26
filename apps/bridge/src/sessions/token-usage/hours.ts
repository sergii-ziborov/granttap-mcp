/**
 * A chat's spend per clock hour, kept beside a provider reader's cached state.
 *
 * Readers add each turn's tokens as they read it, so an incremental read only adds the rows it has not
 * seen. Nothing here reaches the sessions list: the hours travel only as period figures.
 */
export const HOUR_MS = 60 * 60 * 1_000;
/** Hours older than this are dropped; the longest period the phone is told about is 30 days. */
export const TOKEN_HOURS_KEPT_MS = 31 * 24 * HOUR_MS;
export const MAX_TOKEN_MODEL_NAME = 160;

/** Tokens a chat spent in one clock hour with one model. No `startedAt`: the turn had no time of its own. */
export type TokenHour = { startedAt?: number; model?: string; tokens: number };

/** A reader's running count: hour start (or `UNDATED`) to model name ("" for none) to tokens. */
export type TokenHours = Map<number, Map<string, number>>;

const UNDATED = -1;

/** The start of the computer's local clock hour holding `at`. */
export function hourStart(at: number): number {
  return new Date(at).setMinutes(0, 0, 0);
}

/** The model a turn names; Claude's `<synthetic>` placeholder is no model. */
export function tokenModelName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name && name !== "<synthetic>" ? name.slice(0, MAX_TOKEN_MODEL_NAME) : undefined;
}

export function createTokenHours(): TokenHours {
  return new Map();
}

/** Count one turn. A turn without a valid time counts at the chat's last activity when published. */
export function addTokenHour(hours: TokenHours, at: number | undefined, tokens: number, model?: unknown): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const hour = at != null && Number.isFinite(at) && at > 0 ? hourStart(at) : UNDATED;
  const models = hours.get(hour) ?? new Map<string, number>();
  const name = tokenModelName(model) ?? "";
  models.set(name, (models.get(name) ?? 0) + tokens);
  hours.set(hour, models);
}

/** A snapshot for the reader's cache, oldest hour first. Hours past the kept span leave the count too. */
export function tokenHourRows(hours: TokenHours, now = Date.now()): TokenHour[] {
  const oldest = hourStart(now - TOKEN_HOURS_KEPT_MS);
  const rows: TokenHour[] = [];
  for (const [hour, models] of [...hours].sort(([left], [right]) => left - right)) {
    if (hour !== UNDATED && hour < oldest) {
      hours.delete(hour);
      continue;
    }
    for (const [model, tokens] of models) {
      rows.push({ ...(hour === UNDATED ? {} : { startedAt: hour }), ...(model ? { model } : {}), tokens });
    }
  }
  return rows;
}

/** One chat's hours from its own transcript and its subagents'. */
export function combineTokenHours(lists: ReadonlyArray<readonly TokenHour[] | undefined>, now = Date.now()): TokenHour[] {
  const nonEmpty = lists.filter((list): list is readonly TokenHour[] => !!list?.length);
  if (nonEmpty.length <= 1) return [...(nonEmpty[0] ?? [])];
  const hours = createTokenHours();
  for (const list of nonEmpty) {
    for (const row of list) addTokenHour(hours, row.startedAt, row.tokens, row.model);
  }
  return tokenHourRows(hours, now);
}
