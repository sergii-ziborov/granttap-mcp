import { z } from "zod";

/**
 * How full a chat's context window is, as its provider last reported it. `parts` add up to
 * `usedTokens`; their ids are stable and the phone names them. A window or auto-compact point
 * the provider did not report stays absent rather than guessed.
 */
export const SessionContextUsage = z.object({
  observedAt: z.number().finite().positive(),
  source: z.enum(["claude", "codex"]),
  usedTokens: z.number().int().nonnegative(),
  windowTokens: z.number().int().positive().optional(),
  autoCompactAtTokens: z.number().int().positive().optional(),
  lastOutputTokens: z.number().int().nonnegative().optional(),
  parts: z.array(z.object({
    id: z.string().min(1).max(40),
    tokens: z.number().int().nonnegative(),
  }).strict()).max(16),
}).strict();
export type SessionContextUsage = z.infer<typeof SessionContextUsage>;
