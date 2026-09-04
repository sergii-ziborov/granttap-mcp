import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
export type Checkpoint = { sha: string; branch: string; files: number };

export const CHECKPOINT_BRANCH_PREFIX = "granttap/checkpoint/";

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, env,
    maxBuffer: 16 * 1_024 * 1_024,
  }).trim();
}

export function checkpointBranchName(taskId: string): string {
  return CHECKPOINT_BRANCH_PREFIX + taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
}

export function createCheckpoint(cwd: string, taskId: string, title: string): Checkpoint | undefined {
  const scratch = mkdtempSync(join(tmpdir(), "granttap-checkpoint-"));
  try {
    const head = git(cwd, ["rev-parse", "HEAD"]);
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    // Start the scratch index from HEAD so deletions are recorded too.
    git(cwd, ["read-tree", "HEAD"], env);
    git(cwd, ["add", "-A"], env);
    const tree = git(cwd, ["write-tree"], env);
    if (tree === git(cwd, ["rev-parse", "HEAD^{tree}"])) return undefined; // nothing to keep
    const message = `GrantTap checkpoint: ${title.replace(/\s+/g, " ").slice(0, 120)}`;
    const sha = git(cwd, ["commit-tree", tree, "-p", head, "-m", message], env);
    const branch = checkpointBranchName(taskId);
    git(cwd, ["branch", "-f", branch, sha]);
    const files = git(cwd, ["diff", "--name-only", `${head}..${sha}`]).split("\n").filter(Boolean).length;
    return { sha, branch, files };
  } catch {
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
