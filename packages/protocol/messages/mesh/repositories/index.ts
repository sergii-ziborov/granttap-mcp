/**
 * The repositories a Mesh holds on one computer, read and changed from the
 * phone. A computer lists the checkouts it knows and answers for its own
 * bindings only: it adds one of its checkouts to the Mesh, or takes one of
 * its own out. Every message is scoped to the Project and sent under the
 * Project's key.
 */
import { z } from "zod";
import { Identifier, Label, Path } from "../endpoint";

/** A path that names its own root: POSIX, a drive letter, or a UNC share. */
export const MeshRepositoryPath = Path.refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"),
  "absolute path required",
);
const RepositoryId = z.string().trim().min(1).max(512);
const Moment = z.number().nonnegative();

export const MESH_REPOSITORY_LIST_LIMIT = 200;
export const MESH_REPOSITORY_DETAIL_LIMIT = 300;

function projectScope(value: { sessionId: string; projectId: string }, ctx: z.RefinementCtx): void {
  if (value.sessionId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "project scope mismatch" });
  }
}

/** The phone asks one computer which checkouts it could bind to the Project, and which it has. */
export const MeshRepositoryQuery = z.object({
  type: z.literal("mesh.repository.query"),
  sessionId: Identifier,
  projectId: Identifier,
  requestId: Identifier,
  createdAt: Moment,
}).strict().superRefine(projectScope);
export type MeshRepositoryQuery = z.infer<typeof MeshRepositoryQuery>;

/**
 * One checkout on the answering computer. `boundHere` says the repository is
 * bound to the asking Project on this computer, under `bindingId`; a checkout
 * bound to another Project on this computer names that Project instead.
 */
export const MeshRepositoryCandidate = z.object({
  path: MeshRepositoryPath,
  name: Label,
  repositoryId: RepositoryId,
  boundHere: z.boolean(),
  bindingId: Identifier.optional(),
  otherProjectId: Identifier.optional(),
  otherProjectName: Label.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.boundHere !== (value.bindingId != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bindingId"], message: "a binding id names a binding here" });
  }
  if (value.boundHere && value.otherProjectId != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["otherProjectId"], message: "bound here and elsewhere" });
  }
  if (value.otherProjectName != null && value.otherProjectId == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["otherProjectName"], message: "a name without its Project" });
  }
});
export type MeshRepositoryCandidate = z.infer<typeof MeshRepositoryCandidate>;

/** The answer to a query: bound checkouts first, then the rest by name. */
export const MeshRepositoryList = z.object({
  type: z.literal("mesh.repository.list"),
  sessionId: Identifier,
  projectId: Identifier,
  requestId: Identifier,
  computerId: Identifier,
  repositories: z.array(MeshRepositoryCandidate).max(MESH_REPOSITORY_LIST_LIMIT),
  generatedAt: Moment,
}).strict().superRefine((value, ctx) => {
  projectScope(value, ctx);
  if (new Set(value.repositories.map((item) => item.path)).size !== value.repositories.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["repositories"], message: "duplicate checkout path" });
  }
});
export type MeshRepositoryList = z.infer<typeof MeshRepositoryList>;

export const MeshRepositoryEditAction = z.enum(["add", "remove"]);
export type MeshRepositoryEditAction = z.infer<typeof MeshRepositoryEditAction>;

/**
 * Add a checkout of this computer to the Project (`path`), or take one of
 * this computer's bindings out of it (`bindingId`). The computer checks the
 * field the action needs and answers `invalid` when it is missing.
 */
export const MeshRepositoryEdit = z.object({
  type: z.literal("mesh.repository.edit"),
  sessionId: Identifier,
  projectId: Identifier,
  requestId: Identifier,
  createdAt: Moment,
  action: MeshRepositoryEditAction,
  path: Path.optional(),
  bindingId: Identifier.optional(),
}).strict().superRefine(projectScope);
export type MeshRepositoryEdit = z.infer<typeof MeshRepositoryEdit>;

export const MeshRepositoryEditReason = z.enum([
  "invalid", "mesh-disabled", "unknown-mesh", "not-found", "not-a-repository",
  "already-bound", "bound-elsewhere", "not-this-computer", "last-repository", "failed",
]);
export type MeshRepositoryEditReason = z.infer<typeof MeshRepositoryEditReason>;

/**
 * What became of an edit. A refusal says why; a success may still carry
 * `already-bound`, when the repository was in the Project before the request.
 */
export const MeshRepositoryEditResult = z.object({
  type: z.literal("mesh.repository.edit.result"),
  sessionId: Identifier,
  projectId: Identifier,
  requestId: Identifier,
  action: MeshRepositoryEditAction,
  ok: z.boolean(),
  reason: MeshRepositoryEditReason.optional(),
  detail: z.string().trim().min(1).max(MESH_REPOSITORY_DETAIL_LIMIT).optional(),
  bindingId: Identifier.optional(),
  generatedAt: Moment,
}).strict().superRefine((value, ctx) => {
  projectScope(value, ctx);
  if (!value.ok && value.reason == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "a refusal says why" });
  }
  if (value.ok && value.reason != null && value.reason !== "already-bound") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "a success carries no refusal" });
  }
});
export type MeshRepositoryEditResult = z.infer<typeof MeshRepositoryEditResult>;
