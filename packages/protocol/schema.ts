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
  MeshEndpointPolicy,
  MeshEvent,
  MeshHandoffPrepare,
  MeshSnapshot,
} from "./messages/mesh";
import { MachineLoad } from "./messages/machine";
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
export * from "./messages/machine";
export * from "./messages/mesh";
export * from "./messages/primitives";
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

/**
 * Cheap proof that the machine publisher is alive.
 *
 * Catalog freshness cannot carry this: a full provider scan is unbounded work,
 * so a healthy but busy computer would read as dead and the phone would purge
 * its chat list. Liveness travels on its own fixed cadence and stays transient —
 * it must never occupy the durable relay mailbox.
 */
export const MachineHeartbeat = z.object({
  type: z.literal("machine.heartbeat"),
  machine: z.string().catch("machine"),
  createdAt: z.number().catch(() => Date.now()),
});
export type MachineHeartbeat = z.infer<typeof MachineHeartbeat>;

// Mesh payloads carry cross-field task/project scope checks, so they are
// ZodEffects rather than plain objects. A regular union preserves those checks
// while keeping the same strict `type` discriminator on every member.
export const Payload = z.union([
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
  MeshEvent,
  MeshHandoffPrepare,
  MeshSnapshot,
  MeshEndpointPolicy,
  Hello,
  MachineHeartbeat,
  MachineLoad,
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
