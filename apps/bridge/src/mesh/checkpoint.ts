import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretFilePath } from "../sessions/edit-stats";

/**
 * Commit everything uncommitted to a checkpoint branch, touching nothing else.
 *
 * A Task Capsule carries a commit, so uncommitted work used to block the move
 * until the person committed by hand. This makes the commit for them — on a
 * branch of its own, from a temporary index, so HEAD, the current branch, and
 * the working tree are exactly as the agent left them. Nothing is pushed:
 * publishing a branch is the person's decision, and the destination says so
 * if the commit has not reached it yet.
 */
export type CheckpointStatus = "complete" | "partial" | "requires_review";

export type Checkpoint = {
  sha: string;
  branch: string;
  files: number;
  /** Paths left out because they are secrets by name; never part of a checkpoint. */
  excluded: string[];
  /**
   * complete: every uncommitted change is in the commit. partial: secrets
   * stayed behind, named in `excluded`. requires_review: the checkout was
   * shared with other work, so the commit may carry changes that are not
   * this Task's; the person decides.
   */
  status: CheckpointStatus;
};

export const CHECKPOINT_BRANCH_PREFIX = "granttap/checkpoint/";

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, env,
    maxBuffer: 16 * 1_024 * 1_024,
  }).trim();
}

/**
 * One branch per checkpoint, not per Task. A Task handed off twice used to
 * force-move the same branch, and the first checkpoint's commit was left
 * unreachable. The name carries the moment to the millisecond: the same
 * request tried again lands on the same branch, two requests never do.
 */
export function checkpointBranchName(taskId: string, at?: number): string {
  const base = CHECKPOINT_BRANCH_PREFIX + taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  if (at == null) return base;
  const iso = new Date(at).toISOString();
  const stamp = iso.slice(0, 19).replace(/[-:]/g, "");
  const millis = iso.slice(20, 23);
  return `${base}-${stamp}-${millis}`;
}

export function createCheckpoint(
  cwd: string,
  taskId: string,
  title: string,
  at = Date.now(),
): Checkpoint | undefined {
  const scratch = mkdtempSync(join(tmpdir(), "granttap-checkpoint-"));
  try {
    const head = git(cwd, ["rev-parse", "HEAD"]);
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    // Start the scratch index from HEAD so deletions are recorded too.
    git(cwd, ["read-tree", "HEAD"], env);
    git(cwd, ["add", "-A"], env);
    // A checkpoint is the whole checkout's uncommitted work, so an .env or a
    // key that happened to change in it would be committed and, when the
    // person pushes, published. Those stay as HEAD has them, and are named.
    const excluded = git(cwd, ["diff", "--cached", "--name-only"], env)
      .split("\n").filter(Boolean).filter(secretFilePath);
    if (excluded.length > 0) git(cwd, ["reset", "-q", "--", ...excluded], env);
    const tree = git(cwd, ["write-tree"], env);
    if (tree === git(cwd, ["rev-parse", "HEAD^{tree}"])) return undefined; // nothing to keep
    const message = `GrantTap checkpoint: ${title.replace(/\s+/g, " ").slice(0, 120)}`;
    const sha = git(cwd, ["commit-tree", tree, "-p", head, "-m", message], env);
    const branch = checkpointBranchName(taskId, at);
    git(cwd, ["branch", "-f", branch, sha]);
    const files = git(cwd, ["diff", "--name-only", `${head}..${sha}`]).split("\n").filter(Boolean).length;
    return { sha, branch, files, excluded, status: excluded.length > 0 ? "partial" : "complete" };
  } catch {
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
