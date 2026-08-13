/** Public encrypted wire protocol entry point. */
import { z } from "zod";
import {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolved,
  ApprovalsStatus,
} from "./messages/approvals";
import { CapabilityUsageStatus } from "./messages/capabilities";
import {
  AgentEvent,
  DeliveryReceipt,
  MAX_ATTACHMENT_BASE64_CHARS,
  SessionEventsRequest,
  SessionsRefresh,
  SessionSubscription,
  UserMessage,
} from "./messages/interaction";
import { AgentId, Role } from "./messages/primitives";
import {
  ScheduleDelete,
  SchedulePlanRequest,
  SchedulePlanResult,
  ScheduleRun,
  SchedulesStatus,
  ScheduleSet,
} from "./messages/schedules";
import {
  ConfigSet,
  SessionAccessSet,
  SessionActivity,
  SessionCompact,
  SessionCompactResult,
  SessionKeyGrant,
  SessionMcpSet,
  SessionSealed,
  SessionShellSet,
  SessionSkillSet,
  SessionsStatus,
} from "./messages/sessions";

export * from "./messages/approvals";
export * from "./messages/capabilities";
export * from "./messages/interaction";
export * from "./messages/primitives";
export * from "./messages/schedules";
export * from "./messages/sessions";

export const PROTOCOL_VERSION = 1 as const;

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
  ApprovalResolved,
  ApprovalsStatus,
  UserMessage,
  DeliveryReceipt,
  AgentEvent,
  SessionSubscription,
  SessionEventsRequest,
  SessionsRefresh,
  SessionActivity,
  CapabilityUsageStatus,
  SessionKeyGrant,
  SessionSealed,
  SessionsStatus,
  ConfigSet,
  SessionAccessSet,
  SessionMcpSet,
  SessionSkillSet,
  SessionShellSet,
  SessionCompact,
  SessionCompactResult,
  SchedulesStatus,
  ScheduleSet,
  ScheduleDelete,
  ScheduleRun,
  SchedulePlanRequest,
  SchedulePlanResult,
  Hello,
]).superRefine((payload, ctx) => {
  if (payload.type !== "user.message") return;
  const encodedCharacters = payload.attachments?.reduce(
    (total, item) => total + item.data.length,
    0,
  ) ?? 0;
  if (encodedCharacters > MAX_ATTACHMENT_BASE64_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachments"],
      message: `attachments exceed the ${MAX_ATTACHMENT_BASE64_CHARS}-character encrypted transport budget`,
    });
  }
});
export type Payload = z.infer<typeof Payload>;

/** The routed unit. `nonce`+`box` are the sealed Payload; relay cannot open it. */
export const Envelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  room: z.string(),
  from: Role,
  to: z.union([Role, z.literal("all")]),
  senderId: z.string(),
  deliveryId: z.string().optional(),
  wake: z.boolean().optional(),
  expiresAt: z.number().optional(),
  nonce: z.string(),
  box: z.string(),
});
export type Envelope = z.infer<typeof Envelope>;
