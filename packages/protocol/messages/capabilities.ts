import { z } from "zod";
import {
  CapabilityName,
  CapabilityRoomId,
  CapabilitySessionId,
} from "./primitives";

export const CapabilityUsageKind = z.enum(["mcp", "skill", "cli"]);
export type CapabilityUsageKind = z.infer<typeof CapabilityUsageKind>;

export const CapabilityChatTarget = z.object({
  kind: z.literal("chat"),
  roomId: CapabilityRoomId,
  sessionId: CapabilitySessionId,
});
export type CapabilityChatTarget = z.infer<typeof CapabilityChatTarget>;

export const ObservedCapability = z.object({
  kind: CapabilityUsageKind,
  name: CapabilityName,
  toolName: z.string().min(1).max(240),
  commandPreview: z.string().trim().min(1).max(160).optional(),
  estimatedContextTokens: z.number().int().nonnegative().optional(),
  estimatedBaselineTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type ObservedCapability = z.infer<typeof ObservedCapability>;

export const ActivityEntry = z.object({
  id: z.string(),
  kind: z.enum(["user", "message", "tool", "final", "status"]),
  text: z.string(),
  createdAt: z.number(),
  toolName: z.string().optional(),
  mcpServer: z.string().optional(),
  skill: z.string().optional(),
  estimatedContextTokens: z.number().int().nonnegative().optional(),
  capabilities: z.array(ObservedCapability).max(32).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  childThreadId: z.string().max(256).optional(),
  childThreadTitle: z.string().max(160).optional(),
  childThreadDepth: z.number().int().min(1).max(16).optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

export const CapabilityUsageEvent = z.object({
  sourceId: z.string().min(1).max(512),
  roomId: CapabilityRoomId.optional(),
  sessionId: CapabilitySessionId.optional(),
  kind: CapabilityUsageKind,
  name: CapabilityName,
  toolName: z.string().min(1).max(240),
  commandPreview: z.string().trim().min(1).max(160).optional(),
  deepLinkTarget: CapabilityChatTarget.optional(),
  createdAt: z.number(),
  estimatedContextTokens: z.number().int().nonnegative().optional(),
  estimatedBaselineTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type CapabilityUsageEvent = z.infer<typeof CapabilityUsageEvent>;
export const RemoteCapabilityUsageEvent = CapabilityUsageEvent;
export type RemoteCapabilityUsageEvent = CapabilityUsageEvent;

export const CapabilityUsageStatus = z.object({
  type: z.literal("capability.usage.status"),
  events: z.array(CapabilityUsageEvent).max(200),
  generatedAt: z.number(),
});
export type CapabilityUsageStatus = z.infer<typeof CapabilityUsageStatus>;

export const McpIcon = z.object({
  src: z.string().max(180_000),
  mimeType: z.string().max(80).optional(),
  sizes: z.array(z.string().max(32)).max(8).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  sourceOrigin: z.string().url().optional(),
});
export type McpIcon = z.infer<typeof McpIcon>;

export const McpServerInfo = z.object({
  name: z.string(),
  configuredEnabled: z.boolean(),
  allowed: z.boolean(),
  authStatus: z.string().optional(),
  title: z.string().max(160).optional(),
  websiteUrl: z.string().url().optional(),
  version: z.string().max(80).optional(),
  icons: z.array(McpIcon).max(2).optional(),
  metadataSource: z.literal("mcp").optional(),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

export const SkillInfo = z.object({
  name: z.string(),
  description: z.string().optional(),
  allowed: z.boolean().optional(),
});
export type SkillInfo = z.infer<typeof SkillInfo>;
