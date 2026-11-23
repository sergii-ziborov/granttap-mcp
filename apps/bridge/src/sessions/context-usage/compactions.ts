import type { SessionCompaction, SessionContextUsage } from "../../../../../packages/protocol/schema";
import { ts } from "../support/common";

export type SeenCompaction = NonNullable<SessionCompaction["last"]>;
/** The compactions a transcript records: how many, and the newest. */
export type SeenCompactions = { count: number; last?: SeenCompaction };

/** The same compaction written twice (Codex's item and its event) lands within this span. */
const SAME_COMPACTION_MS = 10_000;

const tokens = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function sized(at: number, trigger: SeenCompaction["trigger"], pre: unknown, post: unknown): SeenCompaction {
  const preTokens = tokens(pre), postTokens = tokens(post);
  return { at, trigger, ...(preTokens != null ? { preTokens } : {}), ...(postTokens != null ? { postTokens } : {}) };
}

/**
 * Claude Code's record of a compaction of the chat itself: `compact_boundary`, with the context
 * before and after and whether Claude did it by itself (`auto`) or someone typed `/compact`.
 */
export function claudeCompactionOf(row: any): SeenCompaction | undefined {
  if (row?.type !== "system" || row.subtype !== "compact_boundary" || row.isSidechain === true) return undefined;
  const at = ts(row.timestamp);
  if (!at) return undefined;
  const meta = row.compactMetadata ?? row.compact_metadata ?? {};
  return sized(Math.round(at), meta.trigger === "auto" ? "auto" : "manual",
    meta.preTokens ?? meta.pre_tokens, meta.postTokens ?? meta.post_tokens);
}

/**
 * Codex's record of a compaction: its `compacted` item or `context_compacted` event. Codex does not
 * say the size after; the size before is the chat's last reading, when there was one.
 */
export function codexCompactionOf(row: any, before?: number): SeenCompaction | undefined {
  const compacted = row?.type === "compacted"
    || (row?.type === "event_msg" && row.payload?.type === "context_compacted");
  const at = compacted ? ts(row.timestamp) : undefined;
  return at ? sized(Math.round(at), "provider", before, undefined) : undefined;
}

/** One more compaction; the same one written twice close together counts once. */
export function noteCompaction(seen: SeenCompactions | undefined, entry: SeenCompaction): SeenCompactions {
  const last = seen?.last;
  if (last && seen && Math.abs(entry.at - last.at) <= SAME_COMPACTION_MS && last.trigger === entry.trigger) {
    return { count: seen.count, last: { ...entry, ...last } };
  }
  return { count: (seen?.count ?? 0) + 1, last: entry };
}

/** What the window holds right after a compaction, when the provider said; unknown otherwise. */
export function compactedContext(entry: SeenCompaction, source: SessionContextUsage["source"]): SessionContextUsage | undefined {
  return entry.postTokens == null ? undefined
    : { observedAt: entry.at, source, usedTokens: entry.postTokens, parts: [] };
}

/** `912k`: the scale the phone uses, for the line the chat shows. */
export function tokenScale(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}

/**
 * The status line a Claude compaction shows in the chat, or `""` for the summary Claude writes after
 * one: it is Claude's note to itself, not something the person said. Undefined for any other row.
 */
export function claudeCompactionNotice(row: any): string | undefined {
  if (row?.isCompactSummary === true) return "";
  const entry = claudeCompactionOf(row);
  if (!entry) return undefined;
  const how = entry.trigger === "auto" ? "Claude Code compacted the context by itself" : "The context was compacted";
  const size = entry.preTokens != null && entry.postTokens != null
    ? `: ${tokenScale(entry.preTokens)} → ${tokenScale(entry.postTokens)} tokens` : "";
  return `${how}${size}.`;
}
