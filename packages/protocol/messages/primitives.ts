import { z } from "zod";

export const Role = z.enum(["machine", "phone"]);
export type Role = z.infer<typeof Role>;

/** Which agent produced a request. Open string: Claude, Codex, or another provider. */
export const AgentId = z.string().min(1);

export const CodingAgent = z.enum(["claude", "codex", "cursor", "grok"]);
export type CodingAgent = z.infer<typeof CodingAgent>;

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;
export const DangerLevel = z.enum(["safe", "caution", "dangerous", "destructive"]);
export type DangerLevel = z.infer<typeof DangerLevel>;

/**
 * A question whose waiting agent accepts an explicit "I won't answer" and goes on
 * without an answer. The computer names it on the question; a controller sends it
 * back on its reply only then, so an older computer is never sent one.
 */
export const QuestionDecline = z.literal("decline-v1");
export type QuestionDecline = z.infer<typeof QuestionDecline>;

export const AutoAcceptLevel = z.enum([
  "ask",
  "safe",
  "except_push",
  "except_destructive",
  "full",
]);

export const CapabilitySessionId = z.string().trim().min(1).max(256);
export const CapabilityName = z.string().trim().min(1).max(160);
export const CapabilityRoomId = z.string().trim().min(1).max(256);
