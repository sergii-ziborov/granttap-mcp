import { execFileSync } from "node:child_process";
import { repositoryHasCommit } from "./worktree";

/**
 * The one moment GrantTap touches a remote: a handoff to another computer.
 *
 * A capsule names a commit, and a destination that does not have it can only
 * fetch it. Pushing the branch is the person's choice per handoff, never a
 * force push, and only the branch the capsule names; fetching on the far side
 * is the same branch, or everything the remote has when no branch is known.
 */
export type PushResult = { ok: true; remote: string } | { ok: false; error: string };

function git(cwd: string, args: string[], timeout = 60_000): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 4 * 1_024 * 1_024,
  }).trim();
}

/** "origin" when the checkout has it, else its first remote, else nothing. */
export function defaultRemote(cwd: string): string | undefined {
  try {
    const remotes = git(cwd, ["remote"], 5_000).split("\n").map((line) => line.trim()).filter(Boolean);
    return remotes.includes("origin") ? "origin" : remotes[0];
  } catch {
    return undefined;
  }
}

export function pushBranch(cwd: string, branch: string | undefined): PushResult {
  if (!branch) return { ok: false, error: "There is no branch to push: the checkout is on a detached commit." };
  const remote = defaultRemote(cwd);
  if (!remote) return { ok: false, error: "This checkout has no remote to push to." };
  try {
    git(cwd, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`], 120_000);
    return { ok: true, remote };
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.toString().trim().split("\n").at(-1)
      ?? (error as Error).message;
    return { ok: false, error: `Push of ${branch} to ${remote} failed: ${detail.slice(0, 300)}` };
  }
}

/** Fetch until the commit resolves; whether it does. */
export function fetchRevision(repository: string, revision: string, branch?: string): boolean {
  if (repositoryHasCommit(repository, revision)) return true;
  const remote = defaultRemote(repository);
  if (!remote) return false;
  try {
    git(repository, branch ? ["fetch", remote, branch] : ["fetch", remote], 120_000);
  } catch {
    return false;
  }
  return repositoryHasCommit(repository, revision);
}
