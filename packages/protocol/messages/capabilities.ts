import { z } from "zod";
import {
  CapabilityName,
  CapabilityRoomId,
  CapabilitySessionId,
} from "./primitives";

export const CapabilityUsageKind = z.enum(["mcp", "skill", "cli"]);
export type CapabilityUsageKind = z.infer<typeof CapabilityUsageKind>;
export const CapabilityOutcome = z.enum(["success", "error", "cancelled", "unknown"]);
export type CapabilityOutcome = z.infer<typeof CapabilityOutcome>;

export const CapabilityResourceAttribution = z.enum([
  "measured",
  "attributed",
  "estimated",
  "unknown",
]);
export type CapabilityResourceAttribution = z.infer<typeof CapabilityResourceAttribution>;

const ResourceDuration = z.number().int().nonnegative().max(30 * 24 * 60 * 60 * 1_000);
const ResourceBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ResourceDelta = z.number().int().min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export const CapabilityResourceUsage = z.object({
  attribution: CapabilityResourceAttribution,
  cpuTimeMs: ResourceDuration.optional(),
  cpuUserMs: ResourceDuration.optional(),
  cpuSystemMs: ResourceDuration.optional(),
  rssStartBytes: ResourceBytes.optional(),
  rssEndBytes: ResourceBytes.optional(),
  peakRssBytes: ResourceBytes.optional(),
  memoryDeltaBytes: ResourceDelta.optional(),
  childPeakRssBytes: ResourceBytes.optional(),
  processCount: z.number().int().nonnegative().max(1_000_000).optional(),
  ioReadBytes: ResourceBytes.optional(),
  ioWriteBytes: ResourceBytes.optional(),
  sampleWindowMs: ResourceDuration.optional(),
}).strict();
export type CapabilityResourceUsage = z.infer<typeof CapabilityResourceUsage>;

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
  outcome: CapabilityOutcome.default("unknown"),
  errorClass: z.string().trim().min(1).max(80).optional(),
  resource: CapabilityResourceUsage.optional(),
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
  outcome: CapabilityOutcome.default("unknown"),
  errorClass: z.string().trim().min(1).max(80).optional(),
  resource: CapabilityResourceUsage.optional(),
});
export type CapabilityUsageEvent = z.infer<typeof CapabilityUsageEvent>;
export const RemoteCapabilityUsageEvent = CapabilityUsageEvent;
export type RemoteCapabilityUsageEvent = CapabilityUsageEvent;

/**
 * What a period actually contained.
 *
 * The event list is bounded by a byte budget, so on a busy computer it holds
 * only the newest hours: counting it produced a "last 30 days" that silently
 * meant "the last eighty calls", and a capability used yesterday read as never
 * used at all. Totals are counted on the computer, where the whole period is
 * visible, and travel as a handful of rows.
 */
export const CapabilityUsageTotal = z.object({
  windowHours: z.number().int().positive().max(24 * 400),
  kind: CapabilityUsageKind,
  /** Absent for the roll-up of a whole kind. */
  name: CapabilityName.optional(),
  count: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  lastUsedAt: z.number().nonnegative(),
}).strict();
export type CapabilityUsageTotal = z.infer<typeof CapabilityUsageTotal>;

export const CapabilityUsageStatus = z.object({
  type: z.literal("capability.usage.status"),
  events: z.array(CapabilityUsageEvent).max(200),
  totals: z.array(CapabilityUsageTotal).max(160).optional(),
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
