import { z } from "zod";
import { CodingAgent } from "../primitives";

export const ProviderHook = z.object({
  event: z.enum(["PreToolUse", "PermissionRequest"]),
  trustStatus: z.enum(["trusted", "untrusted", "modified", "unknown", "missing"]),
  enabled: z.boolean(),
  key: z.string().min(1).max(512).optional(),
  currentHash: z.string().min(1).max(128).optional(),
  command: z.string().min(1).max(2_048).optional(),
});
export type ProviderHook = z.infer<typeof ProviderHook>;

export const ProviderHookTrust = z.object({
  type: z.literal("provider.hook.trust"),
  agent: z.literal("codex"),
  endpointId: z.string().min(1).max(160),
  event: z.enum(["PreToolUse", "PermissionRequest"]),
  key: z.string().min(1).max(512),
  currentHash: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  createdAt: z.number().finite(),
});
export type ProviderHookTrust = z.infer<typeof ProviderHookTrust>;

export const ProviderHookTrustResult = z.object({
  type: z.literal("provider.hook.trust.result"),
  agent: z.literal("codex"),
  endpointId: z.string().min(1).max(160),
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  message: z.string().max(512),
  hooks: z.array(ProviderHook).max(2),
  checkedAt: z.number().finite(),
});
export type ProviderHookTrustResult = z.infer<typeof ProviderHookTrustResult>;

export const AgentIntegrationStatus = z.object({
  agent: CodingAgent,
  installed: z.boolean(),
  hookConfigured: z.boolean(),
  endpointId: z.string().min(1).max(160).optional(),
  hooks: z.array(ProviderHook).max(2).optional(),
  hooksCheckedAt: z.number().finite().optional(),
  // The tool itself: which version answers on this computer, how it is kept
  // current, and whether a newer copy already sits on the same disk.
  version: z.string().trim().min(1).max(64).optional(),
  updateCommand: z.string().trim().min(1).max(200).optional(),
  newerOnThisMac: z.string().trim().min(1).max(64).optional(),
  updating: z.boolean().optional(),
});
export type AgentIntegrationStatus = z.infer<typeof AgentIntegrationStatus>;

