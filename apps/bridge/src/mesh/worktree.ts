import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type HandoffWorktree = { path: string; branch: string };

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/** Whether this checkout can already resolve the commit a capsule names. */
export function repositoryHasCommit(repository: string, revision: string): boolean {
  if (!/^[0-9a-f]{7,64}$/i.test(revision)) return false;
  try {
    execFileSync("git", ["-C", repository, "cat-file", "-e", `${revision}^{commit}`], {
      stdio: "ignore", timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function createHandoffWorktree(
  repository: string,
  worktreeRoot: string,
  taskId: string,
  provider: string,
  baseSha: string,
  now = Date.now(),
): HandoffWorktree | undefined {
  if (!/^[0-9a-f]{7,64}$/i.test(baseSha)) return undefined;
  const task = safeSegment(taskId) || "task";
  const agent = safeSegment(provider) || "agent";
  const suffix = Math.trunc(now).toString(36);
  const branch = `granttap/${agent}/${task}-${suffix}`;
  const path = join(worktreeRoot, `${task}-${agent}-${suffix}`);
  if (existsSync(path)) return undefined;
  mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
  try {
    execFileSync("git", ["-C", repository, "cat-file", "-e", `${baseSha}^{commit}`], {
      stdio: "ignore", timeout: 3_000,
    });
    execFileSync("git", ["-C", repository, "worktree", "add", "-b", branch, path, baseSha], {
      stdio: "ignore", timeout: 15_000,
    });
    return { path, branch };
  } catch {
    return undefined;
  }
}
