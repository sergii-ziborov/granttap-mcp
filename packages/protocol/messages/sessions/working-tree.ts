import { z } from 'zod';

/**
 * The uncommitted state of a chat's working folder when it is a Git checkout, on the session record.
 * `changed` counts paths `git status` lists (untracked included). `ahead`/`behind` are against the
 * branch's upstream and absent without one. `operation` is set while a merge, rebase, cherry-pick,
 * revert or bisect is in progress. Observed at most every few seconds.
 */
export const SessionWorkingTree = z.object({
  branch: z.string().min(1).max(256).optional(),
  detached: z.boolean().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  changed: z.number().int().nonnegative(),
  operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect']).optional(),
  observedAt: z.number().int().positive(),
}).strict();
export type SessionWorkingTree = z.infer<typeof SessionWorkingTree>;

const scope = { sessionId: z.string().min(1).max(512), requestId: z.string().min(1).max(128) };
/** A 64-hex fingerprint of the listing: the commit is refused when the tree no longer matches it. */
const TreeToken = z.string().regex(/^[a-f0-9]{64}$/);
const RepoPath = z.string().min(1).max(4096);

/**
 * The phone asks for a chat's uncommitted changes, answered only to the phone that asked. `worktree`,
 * an absolute path a listing named among the repository's worktrees, asks for that checkout instead,
 * read-only: its listing has no `treeToken`. A phone sends it only to a computer whose listing had
 * `worktrees`; an older computer refuses the field.
 */
export const SessionChangesQuery = z.object({ type: z.literal('session.changes.query'), ...scope,
  worktree: RepoPath.optional(), createdAt: z.number().finite() }).strict();
export type SessionChangesQuery = z.infer<typeof SessionChangesQuery>;

/**
 * One checkout of the chat's repository, from `git worktree list`: the main one and each linked one.
 * `current` marks the chat's own; `head` is the commit it has out.
 */
export const SessionWorktree = z.object({ path: RepoPath, branch: z.string().min(1).max(256).optional(),
  detached: z.boolean().optional(), head: z.string().regex(/^[a-f0-9]{7,64}$/).optional(),
  current: z.boolean().optional(), locked: z.boolean().optional() }).strict();
export type SessionWorktree = z.infer<typeof SessionWorktree>;

/**
 * Up to 200 changed paths, relative to the checkout's root, with Git's two status letters
 * (`XY` of `git status --porcelain`, e.g. ` M`, `A `, `??`, `R `); a rename names `from`.
 * `folder` is the listed checkout's root; `worktrees`, at most 100, every checkout of its repository.
 */
export const SessionChangesResult = z.object({ type: z.literal('session.changes.result'), ...scope,
  branch: z.string().min(1).max(256).optional(), detached: z.boolean().optional(),
  ahead: z.number().int().nonnegative().optional(), behind: z.number().int().nonnegative().optional(),
  folder: RepoPath.optional(), worktrees: z.array(SessionWorktree).max(100).optional(),
  operation: SessionWorkingTree.shape.operation,
  files: z.array(z.object({ path: RepoPath, status: z.string().regex(/^[ MADRCUT?!]{2}$/), from: RepoPath.optional() })
    .strict()).max(200),
  total: z.number().int().nonnegative(), truncated: z.boolean(), treeToken: TreeToken.optional(),
  unavailable: z.boolean().optional(), createdAt: z.number().finite() }).strict();
export type SessionChangesResult = z.infer<typeof SessionChangesResult>;

/**
 * Commit exactly the paths the phone showed, with this message. `treeToken` is the listing's; with
 * the chat's own turn running the commit needs `confirmWhileWorking`. Never pushes.
 */
export const SessionCommit = z.object({ type: z.literal('session.commit'), ...scope,
  message: z.string().trim().min(1).max(2_000), paths: z.array(RepoPath).min(1).max(200), treeToken: TreeToken,
  confirmWhileWorking: z.boolean().optional(), createdAt: z.number().finite() }).strict();
export type SessionCommit = z.infer<typeof SessionCommit>;

/**
 * `ok` with the new `commit`, or a refusal: `changed` (the tree is not the one listed, or a path is no
 * longer changed), `detached`, `operation` (merge/rebase… in progress), `working` (the chat's turn is
 * running and the phone did not confirm), `unavailable` (no such chat or no checkout), `failed` (Git
 * refused, e.g. a hook; its first line in `detail`).
 */
export const SessionCommitResult = z.object({ type: z.literal('session.commit.result'), ...scope, ok: z.boolean(),
  reason: z.enum(['changed', 'detached', 'operation', 'working', 'unavailable', 'failed']).optional(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), detail: z.string().max(500).optional(),
  createdAt: z.number().finite() }).strict();
export type SessionCommitResult = z.infer<typeof SessionCommitResult>;
