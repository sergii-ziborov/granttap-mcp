import { z } from "zod";
import {
  Detail,
  GitSha,
  Identifier,
  Label,
  MeshExecutionProvider,
  MeshProvider,
  Path,
} from "./endpoint";
import {
  ProjectEnvironment,
  ProjectExecutionPolicy,
  ProjectRestrictionSet,
} from "../project-policy";
export * from "./endpoint";

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
