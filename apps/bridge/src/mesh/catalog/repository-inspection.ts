import { execFile } from "node:child_process";
import { canonicalRepositoryIdentity, sanitizedRepositoryRemote } from "../identity";
import type { RepositoryFacts } from ".";

let running = 0;
const waiting: Array<() => void> = [];
const pending = new Map<string, Promise<RepositoryFacts>>();

/** Native read-only Git work stays bounded without blocking relay callbacks. */
export function readRepositoryGit(cwd: string, args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<string | undefined> {
  return new Promise(resolve => {
    const run = () => {
      running++;
      const done = (error: Error | null, stdout = "") => {
        running--;
        waiting.shift()?.();
        resolve(error ? undefined : stdout);
      };
      try {
        execFile("git", ["--no-optional-locks", "-C", cwd, ...args], {
          encoding: "utf8", timeout: options.timeoutMs ?? 2_000,
          maxBuffer: options.maxBuffer ?? 1024 * 1024, windowsHide: true,
        }, done);
      } catch { done(new Error("Repository command could not start")); }
    };
    if (running < 2) run(); else waiting.push(run);
  });
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  return (await readRepositoryGit(cwd, args))?.trim() || undefined;
}

async function inspect(cwd: string): Promise<RepositoryFacts> {
  const worktree = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = worktree ?? cwd;
  const [rawRemote, revision, branch] = await Promise.all([
    git(root, ["remote", "get-url", "origin"]),
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  return { root, worktree, revision, branch,
    baseRemote: rawRemote ? sanitizedRepositoryRemote(rawRemote) : undefined,
    canonicalRepositoryId: canonicalRepositoryIdentity(rawRemote, root) };
}

/** Share only in-flight observations; a later refresh verifies the checkout again. */
export function inspectRepositoryAsync(cwd: string): Promise<RepositoryFacts> {
  const active = pending.get(cwd);
  if (active) return active;
  const next = inspect(cwd).finally(() => { pending.delete(cwd); });
  pending.set(cwd, next);
  return next;
}

/** A fresh working-tree observation shares the bounded, nonblocking Git command pool. */
export async function inspectWorkingTreeAsync(cwd: string): Promise<boolean | undefined> {
  const output = await readRepositoryGit(cwd, ['status', '--porcelain=v1', '--untracked-files=normal', '-z'],
    { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024 });
  return output === undefined ? undefined : output.length > 0;
}
