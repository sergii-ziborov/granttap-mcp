import { z } from "zod";
import { ActivityEntry, McpServerInfo, SkillInfo } from "./capabilities";
import {
  AgentId,
  AutoAcceptLevel,
  CapabilityName,
  CapabilitySessionId,
} from "./primitives";

export const SessionState = z.enum(["working", "waiting", "idle"]);
export type SessionState = z.infer<typeof SessionState>;

export const AgentAccess = z.enum(["read-only", "workspace", "full"]);
export type AgentAccess = z.infer<typeof AgentAccess>;

export const ChildThreadInfo = z.object({
  threadId: z.string().max(256),
  parentThreadId: z.string().max(256),
  title: z.string().max(160).optional(),
  agentName: z.string().max(160).optional(),
  depth: z.number().int().min(1).max(16),
  state: SessionState,
  startedAt: z.number(),
  lastActivityAt: z.number(),
  tokensSession: z.number().nonnegative(),
  tokensLastTurn: z.number().nonnegative(),
});
export type ChildThreadInfo = z.infer<typeof ChildThreadInfo>;

export const SessionActivity = z.object({
  type: z.literal("session.activity"),
  sessionId: z.string(),
  agent: AgentId,
  state: SessionState,
  entries: z.array(ActivityEntry),
  generatedAt: z.number(),
});
export type SessionActivity = z.infer<typeof SessionActivity>;

export const SessionKeyGrant = z.object({
  type: z.literal("session.key.grant"),
  sessionId: z.string(),
  key: z.string().min(43).max(44),
  createdAt: z.number(),
});
export type SessionKeyGrant = z.infer<typeof SessionKeyGrant>;

export const SessionSealed = z.object({
  type: z.literal("session.sealed"),
  sessionId: z.string(),
  nonce: z.string(),
  box: z.string(),
  createdAt: z.number(),
});
export type SessionSealed = z.infer<typeof SessionSealed>;

export const SessionInfo = z.object({
  sessionId: z.string(),
  agent: AgentId,
  title: z.string().optional(),
  cwd: z.string().optional(),
  branch: z.string().optional(),
  model: z.string().optional(),
  summary: z.string().optional(),
  accessLevel: AgentAccess.optional(),
  state: SessionState,
  startedAt: z.number(),
  lastActivityAt: z.number(),
  tokensSession: z.number(),
  tokensLastTurn: z.number(),
  contextTokensUsed: z.number().optional(),
  contextWindow: z.number().optional(),
  mcpServers: z.array(McpServerInfo).optional(),
  skills: z.array(SkillInfo).optional(),
  childThreads: z.array(ChildThreadInfo).max(32).optional(),
  shellAllowed: z.boolean().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const AgentIntegrationStatus = z.object({
  agent: z.enum(["codex", "claude"]),
  installed: z.boolean(),
  hookConfigured: z.boolean(),
});
export type AgentIntegrationStatus = z.infer<typeof AgentIntegrationStatus>;

export const SessionsStatus = z.object({
  type: z.literal("sessions.status"),
  machine: z.string(),
  sessions: z.array(SessionInfo),
  history: z.array(SessionInfo).max(200).optional(),
  tokensRecent: z.number().optional(),
  tokenWindowHours: z.number().optional(),
  tokensAllTime: z.number().optional(),
  gatingEnabled: z.boolean().optional(),
  excludedSessions: z.array(z.string()).optional(),
  autoAcceptDefault: AutoAcceptLevel.optional(),
  autoAcceptBySession: z.record(AutoAcceptLevel).optional(),
  autoAcceptPaused: z.boolean().optional(),
  agents: z.array(AgentIntegrationStatus).optional(),
  activities: z.array(SessionActivity).optional(),
  generatedAt: z.number(),
});
export type SessionsStatus = z.infer<typeof SessionsStatus>;

export const ConfigSet = z.object({
  type: z.literal("config.set"),
  enabled: z.boolean().optional(),
  excludeSession: z.string().optional(),
  includeSession: z.string().optional(),
  autoAcceptDefault: AutoAcceptLevel.nullish(),
  autoAcceptSession: z.object({
    sessionId: z.string(),
    level: AutoAcceptLevel.nullable(),
  }).nullish(),
  autoAcceptPaused: z.boolean().nullish(),
  createdAt: z.number(),
});
export type ConfigSet = z.infer<typeof ConfigSet>;

export const SessionAccessSet = z.object({
  type: z.literal("session.access.set"),
  sessionId: z.string(),
  accessLevel: AgentAccess,
  createdAt: z.number(),
});
export type SessionAccessSet = z.infer<typeof SessionAccessSet>;

export const SessionMcpSet = z.object({
  type: z.literal("session.mcp.set"),
  sessionId: CapabilitySessionId,
  serverName: CapabilityName,
  allowed: z.boolean(),
  createdAt: z.number(),
});
export type SessionMcpSet = z.infer<typeof SessionMcpSet>;

export const SessionSkillSet = z.object({
  type: z.literal("session.skill.set"),
  sessionId: CapabilitySessionId,
  skillName: CapabilityName,
  allowed: z.boolean(),
  createdAt: z.number(),
});
export type SessionSkillSet = z.infer<typeof SessionSkillSet>;

export const SessionShellSet = z.object({
  type: z.literal("session.shell.set"),
  sessionId: CapabilitySessionId,
  allowed: z.boolean(),
  createdAt: z.number(),
});
export type SessionShellSet = z.infer<typeof SessionShellSet>;

export const SessionCompact = z.object({
  type: z.literal("session.compact"),
  sessionId: z.string(),
  createdAt: z.number(),
});
export type SessionCompact = z.infer<typeof SessionCompact>;

export const SessionCompactResult = z.object({
  type: z.literal("session.compact.result"),
  sessionId: z.string(),
  ok: z.boolean(),
  message: z.string(),
  createdAt: z.number(),
});
export type SessionCompactResult = z.infer<typeof SessionCompactResult>;
