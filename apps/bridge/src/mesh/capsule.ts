import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  TaskCapsule,
  type MeshHandoffPrepare,
  type SessionInfo,
  type TaskCapsule as CapsuleValue,
} from "../../../../packages/protocol/schema";
import { workingTreeState } from "./catalog";
import type { MeshStore } from "./store";
import type { Checkpoint } from "./checkpoint";

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000,
      maxBuffer: 512 * 1_024,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitRaw(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000,
      maxBuffer: 512 * 1_024,
    }) || undefined;
  } catch {
    return undefined;
  }
}

function changedFiles(cwd: string): string[] {
  const status = gitRaw(cwd, ["status", "--porcelain=v1", "-z"]);
  if (!status) return [];
  const files = status.split("\0").flatMap((row) => {
    const value = row.length > 3 ? row.slice(3).trim() : "";
    return value ? [value.split(" -> ").at(-1)!] : [];
  });
  return [...new Set(files)].slice(0, 64);
}

function dirtyDiffHash(cwd: string): string | undefined {
  const diff = git(cwd, ["diff", "--binary", "HEAD"]);
  return diff ? createHash("sha256").update(diff).digest("hex") : undefined;
}

export function buildTaskCapsule(
  store: MeshStore,
  session: SessionInfo,
  request: MeshHandoffPrepare,
  computerId: string,
  checkpoint?: Checkpoint,
): CapsuleValue | undefined {
  const cwd = session.worktree ?? session.cwd;
  const snapshot = store.snapshot(request.projectId);
  const task = snapshot?.tasks.find((item) => item.taskId === request.taskId);
  const project = snapshot?.project;
  if (!cwd || !task || !project || session.taskId !== request.taskId) return undefined;
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (!head) return undefined;
  const capsule = {
    taskId: request.taskId,
    goal: task.goal,
    currentStatus: session.summary ?? session.title ?? task.title,
    sourceProvider: session.agent,
    sourceComputer: computerId,
    targetProvider: request.targetProvider,
    targetActorId: request.targetActorId,
    targetComputer: request.targetComputer,
    repository: project.canonicalRepositoryId,
    baseSha: head,
    branch: session.branch ?? git(cwd, ["branch", "--show-current"]),
    latestCommit: head,
    dirtyDiffHash: dirtyDiffHash(cwd),
    workingTree: workingTreeState(cwd),
    filesChanged: changedFiles(cwd),
    dependencies: snapshot.dependencies
      .filter((item) => item.taskId === request.taskId).map((item) => item.dependsOnTaskId).slice(0, 32),
    resourceClaims: snapshot.claims
      .filter((item) => item.taskId === request.taskId).map((item) => item.resource).slice(0, 64),
    remainingWork: ["Continue the task from the current committed state."],
    importantDecisions: [],
    createdAt: Date.now(),
  };
  // A checkpoint commit is the fact the capsule carries instead of the dirty
  // tree: it holds every change the tree had, so relative to it the tree is
  // clean. Whether the destination has that commit is its own check.
  const described = checkpoint
    ? {
      ...capsule,
      latestCommit: checkpoint.sha,
      branch: checkpoint.branch,
      dirtyDiffHash: undefined,
      workingTree: "clean" as const,
      filesChanged: changedFilesBetween(cwd, head, checkpoint.sha),
      remainingWork: [
        `Continue from checkpoint ${checkpoint.sha.slice(0, 12)} on ${checkpoint.branch}.`,
        `Push ${checkpoint.branch} from ${computerId} if the destination does not have it.`,
      ],
    }
    : capsule;
  const parsed = TaskCapsule.safeParse(described);
  return parsed.success ? parsed.data : undefined;
}

function changedFilesBetween(cwd: string, from: string, to: string): string[] {
  const listed = git(cwd, ["diff", "--name-only", `${from}..${to}`]) ?? "";
  return [...new Set(listed.split("\n").map((line) => line.trim()).filter(Boolean))].slice(0, 64);
}
