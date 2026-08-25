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

export const UserMessage = z.object({
  type: z.literal("user.message"),
  messageId: z.string().min(1).max(180).optional(),
  text: z.string(),
  agent: CodingAgent.optional(),
  cwd: z.string().max(4_096).optional(),
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  attachments: z.array(UserAttachment).max(5).optional(),
  preferredMcp: z.string().min(1).max(180).optional(),
  skill: z.string().min(1).max(180).optional(),
  createdAt: z.number(),
});
export type UserMessage = z.infer<typeof UserMessage>;

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
  createdAt: z.number(),
});
export type SessionEventsRequest = z.infer<typeof SessionEventsRequest>;

export const SessionsRefresh = z.object({
  type: z.literal("sessions.refresh"),
  createdAt: z.number(),
});
export type SessionsRefresh = z.infer<typeof SessionsRefresh>;
