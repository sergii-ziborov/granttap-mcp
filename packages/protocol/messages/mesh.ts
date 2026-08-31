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
  branch: z.string().trim().min(1).max(512).optional(),
  worktree: Path.optional(),
  // Uncommitted work cannot travel inside a Task Capsule, so the owning
  // computer publishes whether this execution currently has any.
  uncommitted: z.boolean().optional(),
  // When those facts were last observed, so a late snapshot cannot replace a
  // fresh reading with a stale one.
  updatedAt: z.number().nonnegative().optional(),
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

export const MeshHandoffPrepare = z.object({
  type: z.literal("mesh.handoff.prepare"),
  sessionId: Identifier,
  projectId: Identifier,
  taskId: Identifier,
  targetProvider: MeshExecutionProvider,
  targetActorId: Identifier.optional(),
  targetComputer: Identifier,
  createdAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if ((value.targetProvider === "grok_bot") !== (value.targetActorId != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetActorId"], message: "actor required" });
  }
});
export type MeshHandoffPrepare = z.infer<typeof MeshHandoffPrepare>;

export const MeshSnapshot = z.object({
  type: z.literal("mesh.snapshot"),
  sessionId: Identifier,
  projectId: Identifier,
  project: Project,
  bindings: z.array(ProjectBindingSummary).max(64).optional(),
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
  const bindingIds = new Set(value.bindings?.map((binding) => binding.bindingId));
  const bindingKeys = new Set(value.bindings?.map(
    (binding) => `${binding.endpointId}\0${binding.repositoryId}`,
  ));
  if (bindingIds.size !== (value.bindings?.length ?? 0)
    || bindingKeys.size !== (value.bindings?.length ?? 0)
    || value.bindings?.some((binding) => binding.projectId !== value.projectId)
    || value.tasks.some((task) => task.projectId !== value.projectId)
    || value.executions.some((execution) => !taskIds.has(execution.taskId))
    || value.claims.some((claim) => claim.projectId !== value.projectId || !taskIds.has(claim.taskId))
    || value.dependencies.some((dependency) => !taskIds.has(dependency.taskId))
    || value.events.some((event) => event.projectId !== value.projectId || !taskIds.has(event.taskId))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "snapshot scope mismatch" });
  }
});
export type MeshSnapshot = z.infer<typeof MeshSnapshot>;
