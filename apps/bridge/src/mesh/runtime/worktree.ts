import { execFileSync } from "node:child_process";
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

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

export function createHandoffWorktree(input: {
  repository: string;
  worktreeRoot: string;
  taskId: string;
  provider: string;
  baseSha: string;
  now?: number;
  operationId?: string;
}): HandoffWorktree | undefined {
  const { repository, worktreeRoot, taskId, provider, baseSha, now = Date.now() } = input;
  if (!/^[0-9a-f]{7,64}$/i.test(baseSha)) return undefined;
  if (input.operationId !== undefined && (!input.operationId || input.operationId.length > 128)) return undefined;
  const task = safeSegment(taskId) || "task";
  const agent = safeSegment(provider) || "agent";
  const suffix = input.operationId ? createHash('sha256').update(input.operationId).digest('hex').slice(0, 24)
    : Math.trunc(now).toString(36);
  const branch = `granttap/${agent}/${task}-${suffix}`;
  const path = join(worktreeRoot, `${task}-${agent}-${suffix}`);
  if (existsSync(path)) return input.operationId && reusableWorktree(path, repository, baseSha, branch)
    ? { path, branch } : undefined;
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

function reusableWorktree(path: string, repository: string, revision: string, branch: string): boolean {
  const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000, maxBuffer: 512 * 1_024,
  }).trim();
  try {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) return false;
    const root = realpathSync(path);
    return realpathSync(git(path, ['rev-parse', '--show-toplevel'])) === root
      && realpathSync(resolve(path, git(path, ['rev-parse', '--git-common-dir'])))
        === realpathSync(resolve(repository, git(repository, ['rev-parse', '--git-common-dir'])))
      && git(path, ['rev-parse', 'HEAD']) === git(repository, ['rev-parse', `${revision}^{commit}`])
      && git(path, ['branch', '--show-current']) === branch
      && git(path, ['status', '--porcelain=v1', '--untracked-files=all']) === '';
  } catch { return false; }
}
