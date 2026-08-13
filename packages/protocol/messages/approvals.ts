import { z } from "zod";
import { AgentId, Risk } from "./primitives";

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
  createdAt: z.number(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

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
  generatedAt: z.number(),
});
export type ApprovalsStatus = z.infer<typeof ApprovalsStatus>;
