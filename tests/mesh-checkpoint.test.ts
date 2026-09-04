import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../packages/protocol/schema";
import { checkpointBranchName, createCheckpoint } from "../apps/bridge/src/mesh/checkpoint";
import { buildTaskCapsule } from "../apps/bridge/src/mesh/capsule";
import { linkSessionsToProjects, workingTreeState } from "../apps/bridge/src/mesh/catalog";
import { handoffReadiness } from "../apps/bridge/src/mesh/readiness";
import { MeshStore } from "../apps/bridge/src/mesh/store";

const now = 1_800_000_000_000;
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-checkpoint-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@example.com"]); git(root, ["config", "user.name", "t"]);
  await writeFile(join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]); git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

test("a checkpoint keeps uncommitted work on its own branch and touches nothing else", async () => {
  const root = await repo();
  await writeFile(join(root, "README.md"), "changed\n");
  await writeFile(join(root, "new.txt"), "new\n");
  const head = git(root, ["rev-parse", "HEAD"]);

  const checkpoint = createCheckpoint(root, "task-1", "Pairing refactor");
  assert.ok(checkpoint, "a dirty tree yields a checkpoint");
  assert.equal(checkpoint.branch, checkpointBranchName("task-1"));
  assert.equal(checkpoint.files, 2);
  // The branch holds the work; HEAD, the current branch, and the tree do not move.
  assert.equal(git(root, ["rev-parse", checkpoint.branch]), checkpoint.sha);
  assert.equal(git(root, ["rev-parse", "HEAD"]), head);
  assert.equal(git(root, ["branch", "--show-current"]), "main");
  assert.equal(git(root, ["show", `${checkpoint.sha}:new.txt`]), "new");
  assert.equal(workingTreeState(root), "dirty", "the working tree is left exactly as the agent had it");
  // Nothing staged in the real index either.
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "");

  // A clean tree has nothing to keep, and says so rather than making an empty commit.
  git(root, ["checkout", "-q", "--", "README.md"]); execFileSync("rm", [join(root, "new.txt")]);
  assert.equal(createCheckpoint(root, "task-1", "x"), undefined);
});

test("with a checkpoint the capsule is clean, names the commit, and the handoff is ready", async () => {
  const root = await repo();
  await writeFile(join(root, "README.md"), "changed\n");
  const store = new MeshStore(join(await mkdtemp(join(tmpdir(), "granttap-mesh-")), "mesh.json"), () => now);
  const session: SessionInfo = {
    sessionId: "chat", agent: "claude", title: "Pairing refactor", cwd: root, branch: "main",
    state: "working", startedAt: now, lastActivityAt: now, tokensSession: 1, tokensLastTurn: 1,
  };
  const linked = linkSessionsToProjects(store, [session], "MacBook")[0]!;
  const request = {
    type: "mesh.handoff.prepare" as const, sessionId: "chat", projectId: linked.projectId!,
    taskId: linked.taskId!, targetProvider: "codex" as const, targetComputer: "Studio", createdAt: now,
    checkpoint: true,
  };
  // Without a checkpoint the dirty tree blocks the move, as before.
  const dirty = buildTaskCapsule(store, linked, request, "MacBook");
  assert.equal(dirty?.workingTree, "dirty");
  assert.equal(handoffReadiness({ capsule: dirty, targetProviderEnabled: true, conflicts: [] }).ready, false);

  const checkpoint = createCheckpoint(root, linked.taskId!, "Pairing refactor")!;
  const capsule = buildTaskCapsule(store, linked, request, "MacBook", checkpoint);
  assert.equal(capsule?.workingTree, "clean");
  assert.equal(capsule?.latestCommit, checkpoint.sha);
  assert.equal(capsule?.branch, checkpoint.branch);
  assert.deepEqual(capsule?.filesChanged, ["README.md"]);
  assert.match(capsule?.remainingWork.join(" ") ?? "", /Push granttap\/checkpoint/);
  const readiness = handoffReadiness({ capsule, targetProviderEnabled: true, conflicts: [] });
  assert.equal(readiness.ready, true, readiness.blockedReason);
});
