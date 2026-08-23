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
