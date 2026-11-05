import type { SessionContextUsage } from "../../../../../packages/protocol/schema";

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** What the provider said about the window itself; anything it did not say stays absent. */
export type ContextLimits = { windowTokens?: number; autoCompactAtTokens?: number };

function limits(value: ContextLimits | undefined): ContextLimits {
  const windowTokens = count(value?.windowTokens) || undefined;
  const autoCompactAtTokens = count(value?.autoCompactAtTokens) || undefined;
  return { ...(windowTokens ? { windowTokens } : {}), ...(autoCompactAtTokens ? { autoCompactAtTokens } : {}) };
}

/** Codex's `token_count` event: the last request's input is the context it carried. */
export function codexContextReport(info: any, observedAt: number): SessionContextUsage | undefined {
  const last = info?.last_token_usage;
  const input = count(last?.input_tokens);
  if (input == null || !(observedAt > 0)) return undefined;
  const cached = Math.min(count(last?.cached_input_tokens) ?? 0, input);
  const output = count(last?.output_tokens);
  return { observedAt, source: "codex", usedTokens: input,
    ...limits({ windowTokens: info?.model_context_window }),
    ...(output != null ? { lastOutputTokens: output } : {}),
    parts: [{ id: "cached-input", tokens: cached }, { id: "new-input", tokens: input - cached }] };
}

const CLAUDE_COUNTERS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

/** A Claude assistant turn's `usage`: its prompt is what the conversation now holds. */
export function claudeContextReport(usage: any, observedAt: number, window?: ContextLimits): SessionContextUsage | undefined {
  // One malformed counter rejects the row, as the session's token totals do.
  if (CLAUDE_COUNTERS.some(key => usage?.[key] !== undefined && count(usage[key]) == null)) return undefined;
  const input = count(usage?.input_tokens);
  const written = count(usage?.cache_creation_input_tokens);
  const read = count(usage?.cache_read_input_tokens);
  if ((input == null && written == null && read == null) || !(observedAt > 0)) return undefined;
  const parts = [{ id: "cache-read", tokens: read ?? 0 }, { id: "cache-write", tokens: written ?? 0 },
    { id: "new-input", tokens: input ?? 0 }];
  const used = parts.reduce((sum, part) => sum + part.tokens, 0);
  if (!Number.isSafeInteger(used)) return undefined;
  const output = count(usage?.output_tokens);
  return { observedAt, source: "claude", usedTokens: used, ...limits(window),
    ...(output != null ? { lastOutputTokens: output } : {}), parts };
}
