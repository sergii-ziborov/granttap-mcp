import { z } from "zod";
import {
  Detail,
  GitSha,
  Identifier,
  Label,
  MeshExecutionProvider,
  Path,
} from "./mesh-endpoint";
export * from "./mesh-endpoint";

export const Project = z.object({
  projectId: Identifier,
  name: Label,
  repositoryRoot: Path.optional(),
  canonicalRepositoryId: z.string().trim().min(1).max(512),
  baseRemote: z.string().trim().min(1).max(1_024).optional(),
  createdAt: z.number().nonnegative(),
}).strict();
export type Project = z.infer<typeof Project>;

export const ProjectBindingSummary = z.object({
  bindingId: Identifier,
  projectId: Identifier,
  endpointId: Identifier,
  repositoryId: z.string().trim().min(1).max(512),
  displayName: Label,
  localPathHint: Path.optional(),
  available: z.boolean(),
  revision: z.string().trim().min(1).max(512).optional(),
}).strict();
export type ProjectBindingSummary = z.infer<typeof ProjectBindingSummary>;

export const TaskState = z.enum([
  "planned", "working", "blocked", "needs_user", "handoff", "completed", "failed",
]);
export type TaskState = z.infer<typeof TaskState>;

export const MeshTask = z.object({
  taskId: Identifier,
  projectId: Identifier,
  title: Label,
  goal: Detail,
  state: TaskState,
  ownerSessionId: Identifier.optional(),
  // Ordered convergence: every writer raises `revision` when it changes a task,
  // so a delayed snapshot or replayed event can never restore an older owner or
  // reopen finished work. Absent means a pre-revision publisher, read as 0.
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type MeshTask = z.infer<typeof MeshTask>;

export const ExecutionSessionLink = z.object({
  taskId: Identifier,
  sessionId: Identifier,
  provider: MeshExecutionProvider,
  actorId: Identifier.optional(),
  computerId: Identifier,
  workspace: Path,
  // The repository the workspace belongs to, by canonical id, so a Task can be
  // placed on the integration map without anyone re-reading its git remote.
  repositoryId: z.string().trim().min(1).max(512).optional(),
  branch: z.string().trim().min(1).max(512).optional(),
  worktree: Path.optional(),
  // Uncommitted work cannot travel inside a Task Capsule, so the owning
  // computer publishes whether this execution currently has any.
  uncommitted: z.boolean().optional(),
  // When those facts were last observed, so a late snapshot cannot replace a
  // fresh reading with a stale one.
  updatedAt: z.number().nonnegative().optional(),
  // When the chat itself last did anything. An execution stays open while its
  // chat exists, which is not the same as the chat being alive: without this,
  // every idle chat of the week read as live work.
  activeAt: z.number().nonnegative().optional(),
  startedAt: z.number().nonnegative(),
  endedAt: z.number().nonnegative().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.provider === "grok_bot") !== (value.actorId != null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["actorId"],
      message: "Grok Bot executions require one actorId",
    });
  }
});
export type ExecutionSessionLink = z.infer<typeof ExecutionSessionLink>;

export const ResourceClaimMode = z.enum(["intent", "claim", "hard"]);
export const ResourceClaim = z.object({
  claimId: Identifier,
  projectId: Identifier,
  taskId: Identifier,
  ownerSessionId: Identifier,
  repositoryId: z.string().trim().min(1).max(512).optional(),
  endpointId: Identifier.optional(),
  worktree: Path.optional(),
  resource: Path,
  mode: ResourceClaimMode,
  createdAt: z.number().nonnegative(),
  expiresAt: z.number().positive(),
}).strict();
export type ResourceClaim = z.infer<typeof ResourceClaim>;

export const TaskDependency = z.object({
  taskId: Identifier,
  dependsOnTaskId: Identifier,
  summary: Detail.optional(),
  createdAt: z.number().nonnegative(),
}).strict();
export type TaskDependency = z.infer<typeof TaskDependency>;

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

export const IntegrationVia = z.enum(["database", "kafka", "api"]);
export type IntegrationVia = z.infer<typeof IntegrationVia>;
export const IntegrationRelation = z.enum(["produces", "consumes", "calls", "called_by", "shares"]);
export type IntegrationRelation = z.infer<typeof IntegrationRelation>;

/**
 * One edge of the integration map a bound repository keeps in its
 * `WEAVATRIX.md`: the other repository on the far side of a database, a topic,
 * or an API, as that repository states it. Only stated edges travel; nothing is
 * inferred on the way.
 */
export const IntegrationPeer = z.object({
  projectId: Identifier,
  repositoryId: z.string().trim().min(1).max(512),
  peer: Label,
  via: IntegrationVia,
  relation: IntegrationRelation,
  through: Label.optional(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type IntegrationPeer = z.infer<typeof IntegrationPeer>;

/**
 * One SKILL.md the Project catalog published. Presence is not permission;
 * Governance is the only authority for what may run.
 */
export const SharedSkillState = z.enum(["installed", "available", "used", "unknown"]);
export type SharedSkillState = z.infer<typeof SharedSkillState>;
export const SharedSkill = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(500).optional(),
  version: z.string().trim().min(1).max(64).optional(),
  digest: z.string().trim().min(1).max(128).optional(),
  source: z.string().trim().min(1).max(240).optional(),
  state: SharedSkillState.optional(),
}).strict();
export type SharedSkill = z.infer<typeof SharedSkill>;

export const MeshSnapshot = z.object({
  type: z.literal("mesh.snapshot"),
  sessionId: Identifier,
  projectId: Identifier,
  project: Project,
  bindings: z.array(ProjectBindingSummary).max(64).optional(),
  peers: z.array(IntegrationPeer).max(64).optional(),
  skills: z.array(SharedSkill).max(64).optional(),
  incomplete: z.boolean().optional(),
  tasks: z.array(MeshTask).max(64),
  executions: z.array(ExecutionSessionLink).max(128),
  claims: z.array(ResourceClaim).max(128),
  dependencies: z.array(TaskDependency).max(128),
  events: z.array(MeshEvent).max(128),
  generatedAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId || value.project.projectId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "project scope mismatch" });
  }
  const taskIds = new Set(value.tasks.map((task) => task.taskId));
  const skillNames = new Set(value.skills?.map((skill) => skill.name));
  if ((value.skills?.length ?? 0) !== skillNames.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skills"], message: "duplicate skill name" });
  }
  const bindingIds = new Set(value.bindings?.map((binding) => binding.bindingId));
  const bindingKeys = new Set(value.bindings?.map(
    (binding) => `${binding.endpointId}\0${binding.repositoryId}`,
  ));
  if (bindingIds.size !== (value.bindings?.length ?? 0)
    || bindingKeys.size !== (value.bindings?.length ?? 0)
    || value.bindings?.some((binding) => binding.projectId !== value.projectId)
    || value.peers?.some((peer) => peer.projectId !== value.projectId)
    || value.tasks.some((task) => task.projectId !== value.projectId)
    || value.executions.some((execution) => !taskIds.has(execution.taskId))
    || value.claims.some((claim) => claim.projectId !== value.projectId || !taskIds.has(claim.taskId))
    || value.dependencies.some((dependency) => !taskIds.has(dependency.taskId))
    || value.events.some((event) => event.projectId !== value.projectId || !taskIds.has(event.taskId))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "snapshot scope mismatch" });
  }
});
export type MeshSnapshot = z.infer<typeof MeshSnapshot>;
