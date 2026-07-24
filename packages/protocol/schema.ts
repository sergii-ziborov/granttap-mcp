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
export const UserMessage = z.object({
  type: z.literal("user.message"),
  text: z.string(),
  /** Correlates a reply with an MCP `ask`; absent for ordinary session chat. */
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  createdAt: z.number(),
});
export type UserMessage = z.infer<typeof UserMessage>;

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
  kind: z.enum(["message", "tool", "final", "status"]),
  text: z.string(),
  createdAt: z.number(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/** Where a session currently stands. */
export const SessionState = z.enum(["working", "waiting", "idle"]);
export type SessionState = z.infer<typeof SessionState>;

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

/** One live chat/session on a machine, with its real token spend. */
export const SessionInfo = z.object({
  sessionId: z.string(),
  agent: AgentId,
  title: z.string().optional(),
  cwd: z.string().optional(),
  branch: z.string().optional(),
  model: z.string().optional(),
  state: SessionState,
  startedAt: z.number(),
  lastActivityAt: z.number(),
  /** Tokens for this session, and for its most recent turn. */
  tokensSession: z.number(),
  tokensLastTurn: z.number(),
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
  AgentEvent,
  SessionSubscription,
  SessionActivity,
  SessionsStatus,
  ConfigSet,
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
  /** Relay-visible delivery deadline; content stays encrypted. */
  expiresAt: z.number().optional(),
  nonce: z.string(), // base64
  box: z.string(), // base64: nacl.box(JSON(Payload))
});
export type Envelope = z.infer<typeof Envelope>;
