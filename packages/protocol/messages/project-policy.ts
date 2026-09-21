import { z } from "zod";
import { Identifier, Label, MeshProvider } from "./mesh/endpoint";

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

export const ProjectExecutionMode = z.enum(["distributed", "pinned"]);
export type ProjectExecutionMode = z.infer<typeof ProjectExecutionMode>;
export const HostGrantStatus = z.enum(["none", "pending", "applied", "unavailable"]);
export type HostGrantStatus = z.infer<typeof HostGrantStatus>;
export const ExecutionOfflineBehavior = z.enum(["reject", "queueUntilDeadline"]);
export type ExecutionOfflineBehavior = z.infer<typeof ExecutionOfflineBehavior>;

/** Project-scoped host pin. Does not reroute enrollment, revoke, or approvals. */
export const ProjectExecutionPolicy = z.object({
  mode: ProjectExecutionMode,
  targetEndpointId: Identifier.optional(),
  defaultProvider: MeshProvider.optional(),
  defaultModel: z.string().trim().min(1).max(160).optional(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostGrantId: Identifier.optional(),
  hostGrantStatus: HostGrantStatus.default("none"),
  offlineBehavior: ExecutionOfflineBehavior.default("reject"),
}).strict().superRefine((value, ctx) => {
  if (value.mode === "pinned" && !value.targetEndpointId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["targetEndpointId"], message: "pinned mode needs a host",
    });
  }
});
export type ProjectExecutionPolicy = z.infer<typeof ProjectExecutionPolicy>;

/** Quality gates a Project can share with CI and its repository. */
export const ProjectRestrictionKind = z.enum([
  "max_file_lines", "max_function_lines", "max_file_bytes", "custom",
]);
export type ProjectRestrictionKind = z.infer<typeof ProjectRestrictionKind>;
export const ProjectRestrictionScope = z.enum([
  "project", "project_and_repo", "sync_from_repo",
]);
export type ProjectRestrictionScope = z.infer<typeof ProjectRestrictionScope>;
export const ProjectRestrictionRule = z.object({
  ruleId: Identifier,
  kind: ProjectRestrictionKind,
  limit: z.number().int().positive().max(1_000_000).optional(),
  name: Label.optional(),
  paths: z.array(z.string().trim().min(1).max(256)).max(16).optional(),
  effect: z.enum(["ask", "deny"]).default("deny"),
}).strict().superRefine((value, ctx) => {
  if (value.kind !== "custom" && value.limit == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["limit"], message: "limit required",
    });
  }
  if (value.kind === "custom" && !value.name) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["name"], message: "custom needs a name",
    });
  }
});
export type ProjectRestrictionRule = z.infer<typeof ProjectRestrictionRule>;
export const ProjectRestrictionSet = z.object({
  projectId: Identifier,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scope: ProjectRestrictionScope,
  repositoryId: z.string().trim().min(1).max(512).optional(),
  rules: z.array(ProjectRestrictionRule).max(32),
  source: z.enum(["phone", "repo"]).default("phone"),
}).strict();
export type ProjectRestrictionSet = z.infer<typeof ProjectRestrictionSet>;

/** Shared Project environment. Secret values travel under the Project key only. */
export const ProjectEnvVar = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  value: z.string().max(4_096).optional(),
  secret: z.boolean(),
}).strict();
export type ProjectEnvVar = z.infer<typeof ProjectEnvVar>;
export const ProjectEnvironment = z.object({
  projectId: Identifier,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  shareNonSecretsWithRepo: z.boolean().default(false),
  variables: z.array(ProjectEnvVar).max(64),
}).strict().superRefine((value, ctx) => {
  const keys = new Set(value.variables.map((item) => item.key));
  if (keys.size !== value.variables.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["variables"], message: "duplicate env key",
    });
  }
});
export type ProjectEnvironment = z.infer<typeof ProjectEnvironment>;

export const ProjectPolicy = z.object({
  projectId: Identifier,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  enforcement: ProjectPolicyEnforcement,
  rules: z.array(ProjectPolicyRule).max(256),
  execution: ProjectExecutionPolicy.optional(),
  restrictions: ProjectRestrictionSet.optional(),
  environment: ProjectEnvironment.optional(),
}).strict().superRefine((policy, ctx) => {
  const ids = new Set(policy.rules.map((rule) => rule.ruleId));
  if (ids.size !== policy.rules.length || policy.rules.some((rule) =>
    rule.projectId !== policy.projectId || rule.revision !== policy.revision)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["rules"], message: "policy rule scope mismatch",
    });
  }
  if (policy.execution && policy.execution.revision > policy.revision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["execution"], message: "execution revision ahead of policy",
    });
  }
  if (policy.restrictions && (
    policy.restrictions.projectId !== policy.projectId
    || policy.restrictions.revision > policy.revision
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["restrictions"], message: "restriction scope mismatch",
    });
  }
  if (policy.environment && (
    policy.environment.projectId !== policy.projectId
    || policy.environment.revision > policy.revision
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["environment"], message: "environment scope mismatch",
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
  /**
   * Names this one edit, so the answer to it can be told from the answer to
   * another edit of the same revision: two people editing at once through
   * one phone each get their own refusal.
   */
  requestId: Identifier.optional(),
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
  /** The edit this answers, echoed from the request that carried one. */
  requestId: Identifier.optional(),
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
