import { z } from "zod";
import { AgentId, DangerLevel, Risk } from "./primitives";

export const ApprovalRequest = z.object({
  type: z.literal("approval.request"),
  requestId: z.string(),
  agent: AgentId,
  kind: z.literal("permission"),
  tool: z.string(),
  title: z.string(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  risk: Risk.default("medium"),
  danger: DangerLevel.nullish(),
  createdAt: z.number(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ActionRequest = z.object({
  id: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256).nullish(),
  agent: AgentId.nullish(),
  kind: z.enum(["permission", "yes_no", "question", "delivery_retry"]),
  title: z.string().min(1).max(2_000),
  detail: z.string().max(2_000).nullish(),
  command: z.string().max(2_000).nullish(),
  risk: DangerLevel,
  state: z.enum(["pending", "submitting", "resolved", "failed"]),
  createdAt: z.number(),
  expiresAt: z.number().nullish(),
});
export type ActionRequest = z.infer<typeof ActionRequest>;

export function approvalAction(request: ApprovalRequest): ActionRequest {
  return {
    id: request.requestId,
    sessionId: request.sessionId,
    agent: request.agent,
    kind: "permission",
    title: request.title,
    command: request.command,
    risk: request.danger ?? (request.risk === "high" ? "dangerous"
      : request.risk === "medium" ? "caution" : "safe"),
    state: "pending",
    createdAt: request.createdAt,
  };
}

export const ApprovalDecision = z.object({
  type: z.literal("approval.decision"),
  requestId: z.string(),
  decision: z.enum(["allow", "deny"]),
  sessionId: z.string().nullish(),
  note: z.string().nullish(),
  decidedBy: z.string().nullish(),
  decidedAt: z.number(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ApprovalResolved = z.object({
  type: z.literal("approval.resolved"),
  requestId: z.string(),
  status: z.enum(["applied", "cancelled", "expired"]),
  decision: z.enum(["allow", "deny"]).nullish(),
  decidedBy: z.string().nullish(),
  note: z.string().nullish(),
  sessionId: z.string().nullish(),
  nativeUiCleared: z.boolean().nullish(),
  resolvedAt: z.number(),
});
export type ApprovalResolved = z.infer<typeof ApprovalResolved>;

const ApprovalStatusScope = z.object({
  requestId: z.string(),
  sessionId: z.string().nullish(),
});

export const ApprovalsStatus = z.object({
  type: z.literal("approvals.status"),
  pending: z.array(ApprovalRequest).max(100),
  complete: z.boolean(),
  covered: z.array(ApprovalStatusScope).max(300).nullish(),
  actions: z.array(ActionRequest).max(100).nullish(),
  generatedAt: z.number(),
});
export type ApprovalsStatus = z.infer<typeof ApprovalsStatus>;
