import { z } from "zod";
import { Identifier, Path } from "./endpoint";

const CallId = z.string().trim().min(1).max(128);
const RepositoryId = z.string().trim().min(1).max(512);
const Hash = z.string().regex(/^[a-f0-9]{64}$/i);
const Sequence = z.number().int().nonnegative().safe();

export const MeshInvocationEvent = z.object({
  event_id: CallId,
  invocation_id: CallId,
  project_id: Identifier,
  task_id: Identifier,
  execution_id: CallId,
  provider: z.string().trim().min(1).max(32),
  native_call_id: CallId,
  session_id: CallId.nullable().optional(),
  tool_name: z.string().trim().min(1).max(160),
  phase: z.enum([
    "requested", "reported_success", "reported_failure", "reported_unknown",
    "denied", "change_observed", "source_gap",
  ]),
  source: z.enum(["transcript", "hook", "filesystem", "scanner"]),
  occurred_at: Sequence,
  repository_id: RepositoryId.nullable().optional(),
  worktree: Path.nullable().optional(),
  resource: Path.nullable().optional(),
  revision: z.string().trim().min(1).max(512).nullable().optional(),
  content_hash: Hash.nullable().optional(),
  capability_artifact_hash: Hash.nullable().optional(),
  policy_revision: Sequence.nullable().optional(),
  policy_rule_id: CallId.nullable().optional(),
}).strict().superRefine((event, ctx) => {
  if (event.phase === "change_observed" && (event.source !== "filesystem"
    || !event.repository_id || !event.resource || !event.revision || !event.content_hash)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["phase"], message: "change evidence missing" });
  }
});
export type MeshInvocationEvent = z.infer<typeof MeshInvocationEvent>;

export const MeshInvocationQuery = z.object({
  type: z.literal("mesh.invocation.query"),
  sessionId: Identifier,
  projectId: Identifier,
  taskId: Identifier,
  requestId: Identifier,
  tail: z.boolean().optional(),
  beforeSequence: Sequence.optional(),
  afterSequence: Sequence.optional(),
  limit: z.number().int().min(1).max(16).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId || (value.tail && value.afterSequence != null)
    || (value.beforeSequence != null && value.afterSequence != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "invocation query scope invalid" });
  }
});
export type MeshInvocationQuery = z.infer<typeof MeshInvocationQuery>;

export const MeshInvocationPage = z.object({
  type: z.literal("mesh.invocation.page"),
  sessionId: Identifier,
  projectId: Identifier,
  taskId: Identifier,
  requestId: Identifier,
  sourceEndpointId: Identifier,
  availability: z.enum(["ready", "unavailable"]),
  events: z.array(z.object({ sequence: Sequence, event: MeshInvocationEvent }).strict()).max(16),
  nextSequence: Sequence,
  previousSequence: Sequence,
  hasMore: z.boolean(),
  hasOlder: z.boolean(),
  generatedAt: Sequence,
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId
    || value.events.some((row) => row.event.project_id !== value.projectId
      || row.event.task_id !== value.taskId)
    || (value.availability === "unavailable" && value.events.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["events"], message: "invocation page scope invalid" });
  }
});
export type MeshInvocationPage = z.infer<typeof MeshInvocationPage>;
