import { z } from "zod";

export const Role = z.enum(["machine", "phone"]);
export type Role = z.infer<typeof Role>;

/** Which agent produced a request. Open string: Claude, Codex, or another provider. */
export const AgentId = z.string().min(1);

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

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
