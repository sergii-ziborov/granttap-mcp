import { z } from "zod";
import {
  Detail,
  GitSha,
  Identifier,
  MeshExecutionProvider,
  Path,
} from "./endpoint";
import { ResourceClaim } from "./tasks";

export const TaskCapsule = z.object({
  taskId: Identifier,
  goal: Detail,
  currentStatus: Detail,
  sourceProvider: MeshExecutionProvider,
  sourceActorId: Identifier.optional(),
  sourceComputer: Identifier,
  targetProvider: MeshExecutionProvider,
  targetActorId: Identifier.optional(),
  targetComputer: Identifier,
  repository: z.string().trim().min(1).max(1_024),
  baseSha: GitSha,
  branch: z.string().trim().min(1).max(512).optional(),
  latestCommit: GitSha.optional(),
  dirtyDiffHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  // Explicit, because "no diff hash" cannot distinguish a clean checkout from a
  // probe that failed. Anything but `clean` refuses the handoff.
  workingTree: z.enum(["clean", "dirty", "unknown"]).optional(),
  filesChanged: z.array(Path).max(64),
  testsStatus: Detail.optional(),
  dependencies: z.array(Identifier).max(32),
  resourceClaims: z.array(Path).max(64),
  remainingWork: z.array(Detail).max(32),
  importantDecisions: z.array(Detail).max(16),
  /**
   * What the checkpoint commit holds, when the capsule rides on one:
   * complete, partial (secrets stayed on the source computer, named in
   * `excluded`), or requires_review (the checkout was shared with other
   * work, so the commit may carry changes that are not this Task's).
   */
  checkpoint: z.object({
    status: z.enum(["complete", "partial", "requires_review"]),
    files: z.number().int().nonnegative(),
    excluded: z.array(Path).max(32),
  }).strict().optional(),
  createdAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if ((value.sourceProvider === "grok_bot") !== (value.sourceActorId != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceActorId"], message: "actor required" });
  }
  if ((value.targetProvider === "grok_bot") !== (value.targetActorId != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetActorId"], message: "actor required" });
  }
});
export type TaskCapsule = z.infer<typeof TaskCapsule>;

export const HandoffReceipt = z.object({
  sourceSessionId: Identifier,
  targetSessionId: Identifier,
  taskId: Identifier,
  capsuleHash: z.string().regex(/^[0-9a-f]{64}$/),
  acceptedAt: z.number().nonnegative(),
}).strict();
export type HandoffReceipt = z.infer<typeof HandoffReceipt>;

export const MeshEventType = z.enum([
  "TASK_STARTED", "TASK_PROGRESS", "RESOURCE_CLAIM", "RESOURCE_RELEASE", "DEPENDENCY",
  "AGENT_QUESTION", "AGENT_ANSWER", "HANDOFF_REQUEST", "HANDOFF_ACCEPTED",
  "HANDOFF_REJECTED", "ARTIFACT_READY", "COMMIT_READY", "CONFLICT", "TASK_BLOCKED",
  "TASK_COMPLETED",
]);
export type MeshEventType = z.infer<typeof MeshEventType>;

export const MeshEventPayload = z.object({
  summary: Detail.optional(),
  dependsOnTaskId: Identifier.optional(),
  question: Detail.optional(),
  category: z.enum(["technical", "product", "business", "security", "destructive"]).optional(),
  questionEventId: Identifier.optional(),
  answer: Detail.optional(),
  capsule: TaskCapsule.optional(),
  receipt: HandoffReceipt.optional(),
  reason: Detail.optional(),
  claim: ResourceClaim.optional(),
  claimId: Identifier.optional(),
  resource: Path.optional(),
  artifact: Path.optional(),
  commitSha: GitSha.optional(),
  otherOwnerSessionId: Identifier.optional(),
  resolved: z.boolean().optional(),
  needsUser: z.boolean().optional(),
  failed: z.boolean().optional(),
}).strict();
export type MeshEventPayload = z.infer<typeof MeshEventPayload>;

const requiredPayloadField: Partial<Record<MeshEventType, keyof z.infer<typeof MeshEventPayload>>> = {
  TASK_PROGRESS: "summary",
  RESOURCE_CLAIM: "claim",
  RESOURCE_RELEASE: "claimId",
  DEPENDENCY: "dependsOnTaskId",
  AGENT_QUESTION: "question",
  AGENT_ANSWER: "answer",
  HANDOFF_REQUEST: "capsule",
  HANDOFF_ACCEPTED: "receipt",
  HANDOFF_REJECTED: "reason",
  ARTIFACT_READY: "artifact",
  COMMIT_READY: "commitSha",
  CONFLICT: "resource",
  TASK_BLOCKED: "reason",
  TASK_COMPLETED: "summary",
};

export const MeshEvent = z.object({
  type: z.literal("mesh.event"),
  sessionId: Identifier,
  eventId: Identifier,
  projectId: Identifier,
  taskId: Identifier,
  sourceSessionId: Identifier,
  targetSessionId: Identifier.optional(),
  sourceActorId: Identifier.optional(),
  eventType: MeshEventType,
  createdAt: z.number().nonnegative(),
  expiresAt: z.number().positive().optional(),
  payload: MeshEventPayload,
}).strict().superRefine((event, ctx) => {
  if (event.sessionId !== event.taskId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "task scope mismatch" });
  }
  const field = requiredPayloadField[event.eventType];
  if (field && event.payload[field] == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", field], message: "required" });
  }
  const claim = event.payload.claim;
  if (claim && (claim.projectId !== event.projectId
    || claim.taskId !== event.taskId
    || claim.ownerSessionId !== event.sourceSessionId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "claim"], message: "claim scope mismatch" });
  }
  if (event.payload.capsule?.taskId !== undefined
    && event.payload.capsule.taskId !== event.taskId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "capsule"], message: "capsule scope mismatch" });
  }
  if (event.payload.receipt?.taskId !== undefined
    && event.payload.receipt.taskId !== event.taskId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "receipt"], message: "receipt scope mismatch" });
  }
});
export type MeshEvent = z.infer<typeof MeshEvent>;

/**
 * The person releases a claim that is nobody's to release by ownership: an
 * agent that died holding a file, or one that will not let go. The phone
 * sends it to each computer of the Project under the Project's key. It is
 * not a RESOURCE_RELEASE event, which only an owner may make; it is the
 * person's own authority, and the computer writes down that it was used.
 */
export const MeshClaimRelease = z.object({
  type: z.literal("mesh.claim.release"),
  sessionId: Identifier,
  projectId: Identifier,
  claimId: Identifier,
  reason: Detail.optional(),
  requestId: Identifier.optional(),
  createdAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "project scope mismatch" });
  }
});
export type MeshClaimRelease = z.infer<typeof MeshClaimRelease>;

/**
 * What became of a release: done, or refused and why. A computer answers
 * the phone that asked; the phone that shares a Project answers the member
 * who asked through it, so a refusal is seen where the release was made.
 */
export const MeshClaimReleaseReason = z.enum(["unknown_claim", "other_project", "not_allowed", "no_computer"]);
export type MeshClaimReleaseReason = z.infer<typeof MeshClaimReleaseReason>;

export const MeshClaimReleaseResult = z.object({
  type: z.literal("mesh.claim.release.result"),
  sessionId: Identifier,
  projectId: Identifier,
  claimId: Identifier,
  ok: z.boolean(),
  reason: MeshClaimReleaseReason.optional(),
  detail: Detail.optional(),
  requestId: Identifier.optional(),
  generatedAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "project scope mismatch" });
  }
  if (!value.ok && value.reason == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "a refusal says why" });
  }
});
export type MeshClaimReleaseResult = z.infer<typeof MeshClaimReleaseResult>;

export const MeshHandoffPrepare = z.object({
  type: z.literal("mesh.handoff.prepare"),
  sessionId: Identifier,
  projectId: Identifier,
  taskId: Identifier,
  targetProvider: MeshExecutionProvider,
  targetActorId: Identifier.optional(),
  targetComputer: Identifier,
  createdAt: z.number().nonnegative(),
  /**
   * Commit uncommitted work to a checkpoint branch first, so the Task can
   * leave without losing it. The branch is local: GrantTap never pushes.
   */
  checkpoint: z.boolean().optional(),
  /**
   * Publish the branch the capsule names to the repository's remote before the
   * capsule leaves, so a destination on another computer can fetch the commit.
   * Never a force push; the person asks for it per handoff.
   */
  push: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.targetProvider === "grok_bot") !== (value.targetActorId != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetActorId"], message: "actor required" });
  }
});
export type MeshHandoffPrepare = z.infer<typeof MeshHandoffPrepare>;
