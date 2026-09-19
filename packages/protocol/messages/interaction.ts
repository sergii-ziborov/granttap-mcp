import { z } from "zod";
import { CodingAgent } from "./primitives";

export const UserAttachment = z.object({
  name: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  data: z.string().max(8_000_000),
});
export type UserAttachment = z.infer<typeof UserAttachment>;

/** Budget for attachments after the task and device encryption layers. */
export const MAX_ATTACHMENT_BASE64_CHARS = 16_000_000;

/** Photos, sketches and files on one message. The phone and the Mac share this. */
export const MAX_USER_ATTACHMENTS = 10;

/**
 * An attachment sent ahead of its message, as soon as it was picked, so the
 * message that follows can name it instead of carrying it.
 */
export const UserAttachmentUpload = z.object({
  type: z.literal("user.attachment"),
  attachmentId: z.string().regex(/^[A-Za-z0-9_-]{1,180}$/),
  name: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  data: z.string().max(8_000_000),
  createdAt: z.number(),
});
export type UserAttachmentUpload = z.infer<typeof UserAttachmentUpload>;

export const UserAttachmentRef = z.object({
  attachmentId: z.string().regex(/^[A-Za-z0-9_-]{1,180}$/),
  name: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
});
export type UserAttachmentRef = z.infer<typeof UserAttachmentRef>;

/** The receipt error a phone reads as "send the attachments again, inline". */
export const ATTACHMENT_MISSING_ERROR = "attachment-missing";

export const UserMessage = z.object({
  type: z.literal("user.message"),
  messageId: z.string().min(1).max(180).optional(),
  text: z.string(),
  agent: CodingAgent.optional(),
  cwd: z.string().max(4_096).optional(),
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  attachments: z.array(UserAttachment).max(MAX_USER_ATTACHMENTS).optional(),
  /** Attachments that came ahead of this message, by id. */
  attachmentRefs: z.array(UserAttachmentRef).max(MAX_USER_ATTACHMENTS).optional(),
  preferredMcp: z.string().min(1).max(180).optional(),
  skill: z.string().min(1).max(180).optional(),
  model: z.string().min(1).max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
  // Spelled out as the CLI spells them. An unknown value is refused here rather
  // than handed to the agent, and a turn that chose nothing omits the field so
  // it reaches the session exactly as it always did.
  permissionMode: z.enum([
    "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan",
  ]).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  createdAt: z.number(),
});
export type UserMessage = z.infer<typeof UserMessage>;

/** A new Project task. Not a reused user.message: no sessionId, cwd is required. */
export const TaskCreate = z.object({
  type: z.literal("project.task.create"),
  operationId: z.string().trim().min(8).max(128),
  text: z.string().min(1).max(32_000),
  cwd: z.string().min(1).max(4_096),
  agent: CodingAgent.optional(),
  model: z.string().min(1).max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
  instanceEpoch: z.string().trim().min(8).max(128).optional(),
  parentSessionId: z.string().trim().min(1).max(180).optional(),
  attachments: z.array(UserAttachment).max(MAX_USER_ATTACHMENTS).optional(),
  attachmentRefs: z.array(UserAttachmentRef).max(MAX_USER_ATTACHMENTS).optional(),
  createdAt: z.number(),
}).strict();
export type TaskCreate = z.infer<typeof TaskCreate>;

/** The pinned host confirms or withdraws its grant. Phone pending is not applied. */
export const HostGrant = z.object({
  type: z.literal("project.execution.host-grant"),
  projectId: z.string().trim().min(1).max(180),
  grant: z.enum(["applied", "unavailable"]),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  instanceEpoch: z.string().trim().min(8).max(128).optional(),
  createdAt: z.number(),
}).strict();
export type HostGrant = z.infer<typeof HostGrant>;

export const DeliveryReceipt = z.object({
  type: z.literal("delivery.receipt"),
  messageId: z.string().min(1).max(180),
  sessionId: z.string().nullish(),
  status: z.enum(["accepted", "rejected"]),
  error: z.string().max(500).optional(),
  receivedAt: z.number(),
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;

export const AgentEvent = z.object({
  type: z.literal("agent.event"),
  text: z.string(),
  requestId: z.string().optional(),
  kind: z.enum(["question", "status", "response"]).optional(),
  sessionId: z.string().optional(),
  agent: CodingAgent.optional(),
  projectId: z.string().min(1).max(128).optional(),
  taskId: z.string().min(1).max(128).optional(),
  computerId: z.string().min(1).max(256).optional(),
  originMessageId: z.string().nullish(),
  createdAt: z.number(),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

export const SessionSubscription = z.object({
  type: z.literal("session.subscribe"),
  sessionId: z.string(),
  active: z.boolean(),
  createdAt: z.number(),
});
export type SessionSubscription = z.infer<typeof SessionSubscription>;

export const SessionEventsRequest = z.object({
  type: z.literal("session.events"),
  sessionId: z.string(),
  /** One agent conversation of the chat, in full, instead of the chat's window. */
  threadId: z.string().max(256).optional(),
  createdAt: z.number(),
});
export type SessionEventsRequest = z.infer<typeof SessionEventsRequest>;

export const SessionsRefresh = z.object({
  type: z.literal("sessions.refresh"),
  createdAt: z.number(),
});
export type SessionsRefresh = z.infer<typeof SessionsRefresh>;
