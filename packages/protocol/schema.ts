/**
 * Wire protocol for GrantTap.
 *
 * Two layers:
 *   - Payload:  the meaningful messages exchanged between a machine (running a
 *               coding agent) and a phone/watch/web client. These are ALWAYS
 *               end-to-end encrypted — the relay never sees them in the clear.
 *   - Envelope: the thin routing wrapper the relay actually reads. Its body is
 *               opaque ciphertext; only `room`, `from`, `to` are visible so the
 *               relay can route without ever learning content (zero-knowledge).
 *
 * The payload set is agent-neutral on purpose: `agent` is just a string, so the
 * same phone UI approves Claude Code, Codex, or anything else that speaks it.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const Role = z.enum(["machine", "phone"]);
export type Role = z.infer<typeof Role>;

/** Which agent produced a request. Open string: "claude", "codex", ... */
export const AgentId = z.string().min(1);

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

/** machine -> phone: "the agent wants to do X, may it?" */
export const ApprovalRequest = z.object({
  type: z.literal("approval.request"),
  requestId: z.string(),
  agent: AgentId,
  kind: z.literal("permission"),
  tool: z.string(), // "Bash", "Edit", "shell", ...
  title: z.string(), // short human line for the notification/watch
  command: z.string().optional(), // full command / detail for the phone screen
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  risk: Risk.default("medium"),
  createdAt: z.number(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** phone -> machine: the tap on Approve/Deny (watch, notification, or in-app). */
export const ApprovalDecision = z.object({
  type: z.literal("approval.decision"),
  requestId: z.string(),
  decision: z.enum(["allow", "deny"]),
  note: z.string().optional(),
  decidedBy: z.string().optional(), // "watch", "phone", "web"
  decidedAt: z.number(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * phone -> machine: free-text sent to the agent's session.
 * This is the foundation for the NEXT step (voice): speech-to-text on the
 * phone/watch simply produces `text` here — no protocol change needed.
 */
export const UserAttachment = z.object({
  name: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  /** Base64 payload; clients resize images and cap raw files before sending. */
  data: z.string().max(8_000_000),
});
export type UserAttachment = z.infer<typeof UserAttachment>;

export const UserMessage = z.object({
  type: z.literal("user.message"),
  /** Stable id makes phone retries idempotent and powers delivery receipts. */
  messageId: z.string().min(1).max(180).optional(),
  text: z.string(),
  /** Agent to use when `sessionId` is absent. Existing sessions own their agent. */
  agent: z.enum(["codex", "claude"]).optional(),
  /** Correlates a reply with an MCP `ask`; absent for ordinary session chat. */
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  attachments: z.array(UserAttachment).max(5).optional(),
  /** Optional real routing hints selected from this task's advertised capabilities. */
  preferredMcp: z.string().min(1).max(180).optional(),
  skill: z.string().min(1).max(180).optional(),
  createdAt: z.number(),
});
export type UserMessage = z.infer<typeof UserMessage>;

/** machine -> phone: the computer accepted one idempotent phone message. */
export const DeliveryReceipt = z.object({
  type: z.literal("delivery.receipt"),
  messageId: z.string().min(1).max(180),
  status: z.enum(["accepted", "rejected"]),
  error: z.string().max(500).optional(),
  receivedAt: z.number(),
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;

/**
 * machine -> phone: something the agent said / a status line.
 * The "listen from them" half of the mic idea maps onto this + TTS later.
 */
export const AgentEvent = z.object({
  type: z.literal("agent.event"),
  text: z.string(),
  /** Present for questions/replies that belong to one request-response exchange. */
  requestId: z.string().optional(),
  kind: z.enum(["question", "status", "response"]).optional(),
  sessionId: z.string().optional(),
  createdAt: z.number(),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

/** phone -> machine: start/stop streaming the safe visible activity of one chat. */
export const SessionSubscription = z.object({
  type: z.literal("session.subscribe"),
  sessionId: z.string(),
  active: z.boolean(),
  createdAt: z.number(),
});
export type SessionSubscription = z.infer<typeof SessionSubscription>;

export const ActivityEntry = z.object({
  id: z.string(),
  kind: z.enum(["user", "message", "tool", "final", "status"]),
  text: z.string(),
  createdAt: z.number(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/** Where a session currently stands. */
export const SessionState = z.enum(["working", "waiting", "idle"]);
export type SessionState = z.infer<typeof SessionState>;

export const AgentAccess = z.enum(["read-only", "workspace", "full"]);
export type AgentAccess = z.infer<typeof AgentAccess>;

export const McpServerInfo = z.object({
  name: z.string(),
  /** Whether the server is enabled in the agent's own configuration. */
  configuredEnabled: z.boolean(),
  /** Effective permission for turns delivered from GrantTap into this task. */
  allowed: z.boolean(),
  authStatus: z.string().optional(),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

export const SkillInfo = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type SkillInfo = z.infer<typeof SkillInfo>;

/** machine -> phone: visible agent output/tool summaries, never hidden reasoning. */
export const SessionActivity = z.object({
  type: z.literal("session.activity"),
  sessionId: z.string(),
  agent: AgentId,
  state: SessionState,
  entries: z.array(ActivityEntry),
  generatedAt: z.number(),
});
export type SessionActivity = z.infer<typeof SessionActivity>;

/**
 * Long-lived device channel grants one random key for one explicitly attached
 * task. The grant itself is already inside the NaCl device box; task traffic is
 * then additionally sealed with this independent key.
 */
export const SessionKeyGrant = z.object({
  type: z.literal("session.key.grant"),
  sessionId: z.string(),
  key: z.string().min(43).max(44),
  createdAt: z.number(),
});
export type SessionKeyGrant = z.infer<typeof SessionKeyGrant>;

/** An inner task payload encrypted under its per-task key. */
export const SessionSealed = z.object({
  type: z.literal("session.sealed"),
  sessionId: z.string(),
  nonce: z.string(),
  box: z.string(),
  createdAt: z.number(),
});
export type SessionSealed = z.infer<typeof SessionSealed>;

/** One live chat/session on a machine, with its real token spend. */
export const SessionInfo = z.object({
  sessionId: z.string(),
  agent: AgentId,
  title: z.string().optional(),
  cwd: z.string().optional(),
  branch: z.string().optional(),
  model: z.string().optional(),
  /** Latest user-visible agent update; never hidden reasoning. */
  summary: z.string().optional(),
  /** Effective filesystem/sandbox access for the next phone-delivered turn. */
  accessLevel: AgentAccess.optional(),
  state: SessionState,
  startedAt: z.number(),
  lastActivityAt: z.number(),
  /** Tokens for this session, and for its most recent turn. */
  tokensSession: z.number(),
  tokensLastTurn: z.number(),
  /** Current model-visible input size and the model's context capacity. */
  contextTokensUsed: z.number().optional(),
  contextWindow: z.number().optional(),
  /** MCP servers and repository skills available to phone-delivered turns. */
  mcpServers: z.array(McpServerInfo).optional(),
  skills: z.array(SkillInfo).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/**
 * machine -> phone: what's running right now.
 * Sent periodically so the phone can show live sessions even when nothing needs
 * a decision — "is it working, for how long, and what has it cost".
 */
export const SessionsStatus = z.object({
  type: z.literal("sessions.status"),
  machine: z.string(),
  sessions: z.array(SessionInfo),
  /** Tokens in the same recent-log window used to discover visible sessions. */
  tokensRecent: z.number().optional(),
  tokenWindowHours: z.number().optional(),
  /** @deprecated Compatibility alias for older phone builds; not truly all-time. */
  tokensAllTime: z.number().optional(),
  /** Current gating switch + exclusions, so the phone can show/toggle them. */
  gatingEnabled: z.boolean().optional(),
  excludedSessions: z.array(z.string()).optional(),
  generatedAt: z.number(),
});
export type SessionsStatus = z.infer<typeof SessionsStatus>;

/** phone -> machine: flip gating on/off, or exclude/include a session. */
export const ConfigSet = z.object({
  type: z.literal("config.set"),
  enabled: z.boolean().optional(),
  excludeSession: z.string().optional(),
  includeSession: z.string().optional(),
  createdAt: z.number(),
});
export type ConfigSet = z.infer<typeof ConfigSet>;

/** phone -> machine: choose sandbox access for subsequent turns in one task. */
export const SessionAccessSet = z.object({
  type: z.literal("session.access.set"),
  sessionId: z.string(),
  accessLevel: AgentAccess,
  createdAt: z.number(),
});
export type SessionAccessSet = z.infer<typeof SessionAccessSet>;

/** phone -> machine: allow or deny one configured MCP server for one task. */
export const SessionMcpSet = z.object({
  type: z.literal("session.mcp.set"),
  sessionId: z.string(),
  serverName: z.string().min(1).max(180),
  allowed: z.boolean(),
  createdAt: z.number(),
});
export type SessionMcpSet = z.infer<typeof SessionMcpSet>;

/** phone -> machine: start real app-server compaction for a Codex task. */
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

/** One terminal-free local schedule owned by GrantTap, for Codex or Claude. */
export const ScheduledTask = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(180),
  agent: z.enum(["codex", "claude"]),
  prompt: z.string().min(1).max(20_000),
  cwd: z.string().min(1),
  cron: z.string().min(9).max(120),
  enabled: z.boolean(),
  createdAt: z.number(),
  lastRunAt: z.number().optional(),
  nextRunAt: z.number().optional(),
  lastResult: z.string().max(500).optional(),
  lastSessionId: z.string().optional(),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

export const ScheduleRunRecord = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  taskTitle: z.string().min(1).max(180),
  agent: z.enum(["codex", "claude"]),
  trigger: z.enum(["schedule", "manual"]),
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  result: z.string().max(500).optional(),
  sessionId: z.string().optional(),
});
export type ScheduleRunRecord = z.infer<typeof ScheduleRunRecord>;

export const SchedulesStatus = z.object({
  type: z.literal("schedules.status"),
  tasks: z.array(ScheduledTask),
  history: z.array(ScheduleRunRecord).max(200).optional(),
  generatedAt: z.number(),
});
export type SchedulesStatus = z.infer<typeof SchedulesStatus>;

export const ScheduleSet = z.object({
  type: z.literal("schedule.set"),
  task: ScheduledTask.omit({ lastRunAt: true, nextRunAt: true, lastResult: true, lastSessionId: true }),
  createdAt: z.number(),
});
export type ScheduleSet = z.infer<typeof ScheduleSet>;

export const ScheduleDelete = z.object({
  type: z.literal("schedule.delete"),
  id: z.string(),
  createdAt: z.number(),
});
export type ScheduleDelete = z.infer<typeof ScheduleDelete>;

export const ScheduleRun = z.object({
  type: z.literal("schedule.run"),
  id: z.string(),
  createdAt: z.number(),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const SchedulePlanTurn = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(8_000),
});
export type SchedulePlanTurn = z.infer<typeof SchedulePlanTurn>;

export const SchedulePlanDraft = z.object({
  title: z.string().min(1).max(180),
  prompt: z.string().min(1).max(20_000),
  cron: z.string().min(9).max(120),
});
export type SchedulePlanDraft = z.infer<typeof SchedulePlanDraft>;

/** phone -> machine: ask a local agent to create or refine a schedule draft. */
export const SchedulePlanRequest = z.object({
  type: z.literal("schedule.plan.request"),
  requestId: z.string().min(1),
  plannerId: z.string().min(1),
  agent: z.enum(["codex", "claude"]),
  cwd: z.string().min(1),
  locale: z.string().max(80).optional(),
  turns: z.array(SchedulePlanTurn).min(1).max(30),
  currentDraft: SchedulePlanDraft.optional(),
  createdAt: z.number(),
});
export type SchedulePlanRequest = z.infer<typeof SchedulePlanRequest>;

/** machine -> phone: conversational reply plus a validated schedule draft. */
export const SchedulePlanResult = z.object({
  type: z.literal("schedule.plan.result"),
  requestId: z.string().min(1),
  plannerId: z.string().min(1),
  ok: z.boolean(),
  message: z.string().min(1).max(8_000),
  draft: SchedulePlanDraft.optional(),
  createdAt: z.number(),
});
export type SchedulePlanResult = z.infer<typeof SchedulePlanResult>;

/** First payload each side sends after connecting (identifies the device). */
export const Hello = z.object({
  type: z.literal("hello"),
  role: Role,
  deviceName: z.string(),
  createdAt: z.number(),
});
export type Hello = z.infer<typeof Hello>;

export const Payload = z.discriminatedUnion("type", [
  ApprovalRequest,
  ApprovalDecision,
  UserMessage,
  DeliveryReceipt,
  AgentEvent,
  SessionSubscription,
  SessionActivity,
  SessionKeyGrant,
  SessionSealed,
  SessionsStatus,
  ConfigSet,
  SessionAccessSet,
  SessionMcpSet,
  SessionCompact,
  SessionCompactResult,
  SchedulesStatus,
  ScheduleSet,
  ScheduleDelete,
  ScheduleRun,
  SchedulePlanRequest,
  SchedulePlanResult,
  Hello,
]);
export type Payload = z.infer<typeof Payload>;

/** The routed unit. `nonce`+`box` are the sealed Payload; relay can't open it. */
export const Envelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  room: z.string(), // pairing id — the relay routes strictly within a room
  from: Role,
  to: z.union([Role, z.literal("all")]),
  senderId: z.string(),
  /** Opaque transport id acknowledged after the peer decrypts the envelope. */
  deliveryId: z.string().optional(),
  /** Content-neutral APNs hint. The relay must not learn the payload kind. */
  wake: z.boolean().optional(),
  /** Relay-visible delivery deadline; content stays encrypted. */
  expiresAt: z.number().optional(),
  nonce: z.string(), // base64
  box: z.string(), // base64: nacl.box(JSON(Payload))
});
export type Envelope = z.infer<typeof Envelope>;
