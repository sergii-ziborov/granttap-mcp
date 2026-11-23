import { z } from "zod";
import { CapabilitySessionId } from "../primitives";

/**
 * Who compacted a chat's context. `auto` and `manual` are the provider's own record (Claude Code's
 * automatic compaction, or a `/compact` someone typed); `provider` is a Codex compaction that does
 * not say which; `phone` and `threshold` are the ones this computer ran, because the person asked
 * from the phone or because the chat reached its GrantTap threshold between turns.
 */
export const SessionCompactionTrigger = z.enum(["auto", "manual", "provider", "phone", "threshold"]);
export type SessionCompactionTrigger = z.infer<typeof SessionCompactionTrigger>;

/**
 * A chat's context compactions and its automatic threshold. `count` is every compaction its
 * transcript records; `last` is the newest, with the context before and after where the provider
 * said. `autoAtTokens` is absent when GrantTap does not compact the chat by itself.
 */
export const SessionCompaction = z.object({
  count: z.number().int().nonnegative(),
  last: z.object({
    at: z.number().int().positive(),
    trigger: SessionCompactionTrigger,
    preTokens: z.number().int().nonnegative().optional(),
    postTokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  /** GrantTap compacts the chat between turns once its context reaches this many tokens. */
  autoAtTokens: z.number().int().positive().optional(),
  /** `autoAtTokens` is this computer's default for the provider, not a value set for the chat. */
  autoAtDefault: z.boolean().optional(),
  /** This computer is compacting the chat now. */
  running: z.boolean().optional(),
}).strict();
export type SessionCompaction = z.infer<typeof SessionCompaction>;

/** The fewest and most tokens a chat's automatic threshold can be set to. */
export const AUTO_COMPACT_MIN_TOKENS = 50_000;
export const AUTO_COMPACT_MAX_TOKENS = 10_000_000;

/**
 * Sets one chat's automatic compaction from the phone: off, a threshold in tokens, or back to the
 * computer's default when `enabled` comes without `atTokens`.
 */
export const SessionAutoCompactSet = z.object({
  type: z.literal("session.autocompact.set"),
  sessionId: CapabilitySessionId,
  enabled: z.boolean(),
  atTokens: z.number().int().min(AUTO_COMPACT_MIN_TOKENS).max(AUTO_COMPACT_MAX_TOKENS).optional(),
  createdAt: z.number(),
}).strict();
export type SessionAutoCompactSet = z.infer<typeof SessionAutoCompactSet>;
