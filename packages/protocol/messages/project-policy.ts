import { z } from "zod";
import { Identifier, Label, MeshProvider } from "./mesh-endpoint";

export const ProjectCapabilityKind = z.enum([
  "agent", "mcp", "skill", "shell", "script", "file_write", "deploy", "network",
]);
export type ProjectCapabilityKind = z.infer<typeof ProjectCapabilityKind>;

export const ProjectPolicyEffect = z.enum(["allow", "ask", "deny"]);
export type ProjectPolicyEffect = z.infer<typeof ProjectPolicyEffect>;
export const ProjectPolicyEnforcement = z.enum(["best_available", "strict"]);
export type ProjectPolicyEnforcement = z.infer<typeof ProjectPolicyEnforcement>;
export const ProjectFingerprintConfidence = z.enum(["exact", "strong", "name_only", "unknown"]);
export type ProjectFingerprintConfidence = z.infer<typeof ProjectFingerprintConfidence>;
export const ProjectEnforcementStatus = z.enum([
  "enforced", "observed", "unsupported", "unknown",
]);
export type ProjectEnforcementStatus = z.infer<typeof ProjectEnforcementStatus>;

export const ProjectCapabilityFingerprint = z.object({
  kind: ProjectCapabilityKind,
  displayName: Label,
  provider: MeshProvider.optional(),
  origin: z.string().trim().min(1).max(512).optional(),
  publisher: Label.optional(),
  version: Label.optional(),
  transport: Label.optional(),
  executablePathHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  configHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  scriptHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  confidence: ProjectFingerprintConfidence,
}).strict();
export type ProjectCapabilityFingerprint = z.infer<typeof ProjectCapabilityFingerprint>;

const ProjectFingerprintPredicate = z.discriminatedUnion("match", [
  z.object({ match: z.literal("exact"), expected: ProjectCapabilityFingerprint }).strict(),
  z.object({ match: z.literal("changed_from"), expected: ProjectCapabilityFingerprint }).strict(),
  z.object({ match: z.literal("confidence"), value: ProjectFingerprintConfidence }).strict(),
]);

export const ProjectPolicySelector = z.object({
  kind: ProjectCapabilityKind.optional(),
  displayName: Label.optional(),
  provider: MeshProvider.optional(),
  origin: z.string().trim().min(1).max(512).optional(),
  fingerprint: ProjectFingerprintPredicate.optional(),
}).strict();

export const ProjectPolicyConditions = z.object({
  endpointIds: z.array(Identifier).max(64),
  providers: z.array(MeshProvider).max(4),
  impact: z.enum(["any", "available", "missing"]).optional(),
}).strict();

export const ProjectPolicyRule = z.object({
  ruleId: Identifier,
  projectId: Identifier,
  selector: ProjectPolicySelector,
  effect: ProjectPolicyEffect,
  conditions: ProjectPolicyConditions,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdBy: Identifier,
}).strict();
export type ProjectPolicyRule = z.infer<typeof ProjectPolicyRule>;

export const ProjectPolicy = z.object({
  projectId: Identifier,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  enforcement: ProjectPolicyEnforcement,
  rules: z.array(ProjectPolicyRule).max(256),
}).strict().superRefine((policy, ctx) => {
  const ids = new Set(policy.rules.map((rule) => rule.ruleId));
  if (ids.size !== policy.rules.length || policy.rules.some((rule) =>
    rule.projectId !== policy.projectId || rule.revision !== policy.revision)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["rules"], message: "policy rule scope mismatch",
    });
  }
});
export type ProjectPolicy = z.infer<typeof ProjectPolicy>;

export const ProjectCapabilityCoverage = z.object({
  kind: ProjectCapabilityKind,
  status: ProjectEnforcementStatus,
}).strict();

export const ProjectPolicyAcknowledgement = z.object({
  projectId: Identifier,
  policyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  endpointId: Identifier,
  provider: MeshProvider,
  capabilities: z.array(ProjectCapabilityCoverage).max(8),
  observedAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.capabilities.map((item) => item.kind)).size !== value.capabilities.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["capabilities"], message: "duplicate capability",
    });
  }
});
export type ProjectPolicyAcknowledgement = z.infer<typeof ProjectPolicyAcknowledgement>;

export const ProjectPolicyCoverage = z.object({
  projectId: Identifier,
  policyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  enforcement: ProjectPolicyEnforcement,
  requiredCapabilities: z.array(ProjectCapabilityKind).max(8),
  endpoints: z.array(ProjectPolicyAcknowledgement).max(32),
  strictReady: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const required = new Set(value.requiredCapabilities);
  const endpoints = new Set(value.endpoints.map((item) => `${item.endpointId}\0${item.provider}`));
  if (required.size !== value.requiredCapabilities.length
    || endpoints.size !== value.endpoints.length
    || value.endpoints.some((item) =>
      item.projectId !== value.projectId || item.policyRevision !== value.policyRevision)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["endpoints"], message: "coverage scope mismatch",
    });
  }
});
export type ProjectPolicyCoverage = z.infer<typeof ProjectPolicyCoverage>;

const ProjectPolicyScope = z.object({
  sessionId: Identifier,
  projectId: Identifier,
});

export const ProjectPolicySet = ProjectPolicyScope.extend({
  type: z.literal("project.policy.set"),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  policy: ProjectPolicy,
  createdAt: z.number().nonnegative(),
}).strict().superRefine(validatePolicyScope);

export const ProjectPolicyStatus = ProjectPolicyScope.extend({
  type: z.literal("project.policy.status"),
  policy: ProjectPolicy,
  coverage: ProjectPolicyCoverage,
  generatedAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  validatePolicyScope(value, ctx);
  if (value.coverage.projectId !== value.projectId
    || value.coverage.policyRevision !== value.policy.revision
    || value.coverage.enforcement !== value.policy.enforcement) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage"], message: "coverage scope mismatch" });
  }
});

export const ProjectPolicyAck = ProjectPolicyScope.extend({
  type: z.literal("project.policy.ack"),
  acknowledgement: ProjectPolicyAcknowledgement,
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId
    || value.acknowledgement.projectId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "Project scope mismatch" });
  }
});

function validatePolicyScope(
  value: { sessionId: string; projectId: string; policy: ProjectPolicy },
  ctx: z.RefinementCtx,
): void {
  if (value.sessionId !== value.projectId || value.policy.projectId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "Project scope mismatch" });
  }
}

/**
 * Why a computer did not apply a policy the phone sent.
 *
 * A refused edit used to be silent: the phone said "saved", the computer
 * kept the old revision, and nothing told anyone. The reason and the
 * revision the computer actually holds let the phone say what happened and
 * offer the edit again on top of the current policy.
 */
export const ProjectPolicyRejectionReason = z.enum([
  "revision_mismatch", "engine_unavailable", "invalid_policy", "unknown",
]);
export type ProjectPolicyRejectionReason = z.infer<typeof ProjectPolicyRejectionReason>;

export const ProjectPolicyRejected = ProjectPolicyScope.extend({
  type: z.literal("project.policy.rejected"),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  reason: ProjectPolicyRejectionReason,
  detail: z.string().trim().min(1).max(240).optional(),
  generatedAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "Project scope mismatch" });
  }
});

export type ProjectPolicySet = z.infer<typeof ProjectPolicySet>;
export type ProjectPolicyStatus = z.infer<typeof ProjectPolicyStatus>;
export type ProjectPolicyAck = z.infer<typeof ProjectPolicyAck>;
export type ProjectPolicyRejected = z.infer<typeof ProjectPolicyRejected>;
export type ProjectPolicyPayload = ProjectPolicySet | ProjectPolicyStatus | ProjectPolicyAck | ProjectPolicyRejected;
