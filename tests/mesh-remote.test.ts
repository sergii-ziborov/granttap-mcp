import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultRemote, fetchRevision, pushBranch } from "../apps/bridge/src/mesh/remote";
import { repositoryHasCommit } from "../apps/bridge/src/mesh/worktree";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function repositories(): Promise<{ source: string; destination: string; bare: string }> {
  const root = await mkdtemp(join(tmpdir(), "granttap-remote-"));
  const bare = join(root, "shared.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const source = join(root, "source");
  execFileSync("git", ["clone", "-q", bare, source]);
  await writeFile(join(source, "README.md"), "base\n");
  git(source, ["add", "README.md"]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "base"]);
  git(source, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  const destination = join(root, "destination");
  execFileSync("git", ["clone", "-q", bare, destination]);
  return { source, destination, bare };
}

test("a handoff branch is pushed by name and fetched on the far side", async () => {
  const { source, destination } = await repositories();
  assert.equal(defaultRemote(source), "origin");
  git(source, ["checkout", "-q", "-b", "granttap/checkpoint/task-1"]);
  await writeFile(join(source, "work.txt"), "in progress\n");
  git(source, ["add", "work.txt"]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "checkpoint"]);
  const sha = git(source, ["rev-parse", "HEAD"]);

  assert.equal(repositoryHasCommit(destination, sha), false);
  assert.equal(fetchRevision(destination, sha, "granttap/checkpoint/task-1"), false, "not published yet");

  const pushed = pushBranch(source, "granttap/checkpoint/task-1");
  assert.deepEqual(pushed, { ok: true, remote: "origin" });
  assert.equal(fetchRevision(destination, sha, "granttap/checkpoint/task-1"), true);
  assert.equal(fetchRevision(destination, sha, "granttap/checkpoint/task-1"), true, "already here");
  assert.equal(repositoryHasCommit(destination, sha), true);

  // Without a branch name the whole remote is fetched.
  await writeFile(join(source, "more.txt"), "more\n");
  git(source, ["add", "more.txt"]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "more"]);
  const more = git(source, ["rev-parse", "HEAD"]);
  git(source, ["push", "-q", "origin", "granttap/checkpoint/task-1"]);
  assert.equal(fetchRevision(destination, more), true);
});

test("a push says why it could not happen instead of forcing anything", async () => {
  const { source } = await repositories();
  assert.match(pushBranch(source, undefined).ok ? "" : (pushBranch(source, undefined) as { error: string }).error, /no branch/);
  const missing = pushBranch(source, "granttap/checkpoint/nothing-here");
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /failed/);

  const lonely = await mkdtemp(join(tmpdir(), "granttap-remote-lonely-"));
  execFileSync("git", ["init", "-q", lonely]);
  assert.equal(defaultRemote(lonely), undefined);
  const noRemote = pushBranch(lonely, "main");
  assert.match(noRemote.ok ? "" : noRemote.error, /no remote/);
  assert.equal(fetchRevision(lonely, "a".repeat(40), "main"), false);
  assert.equal(defaultRemote(join(lonely, "missing")), undefined);
  // A second remote is used when origin is absent.
  git(lonely, ["remote", "add", "mirror", lonely]);
  assert.equal(defaultRemote(lonely), "mirror");
  assert.equal(fetchRevision(lonely, "b".repeat(40), "main"), false, "fetch fails on an empty repository");
});
