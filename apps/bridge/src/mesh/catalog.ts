import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type {
  MeshProvider,
  MeshTask,
  Project,
  SessionInfo,
  TaskState,
} from "../../../../packages/protocol/schema";
import { canonicalRepositoryIdentity, projectIdentity, taskIdentity } from "./identity";
import type { MeshStore } from "./store";

export type RepositoryFacts = {
  root: string;
  canonicalRepositoryId: string;
  baseRemote?: string;
  worktree?: string;
};

const repositoryCache = new Map<string, RepositoryFacts>();

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function inspectRepository(cwd: string): RepositoryFacts {
  const cached = repositoryCache.get(cwd);
  if (cached) return cached;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  const baseRemote = git(root, ["remote", "get-url", "origin"]);
  const facts = {
    root,
    baseRemote,
    canonicalRepositoryId: canonicalRepositoryIdentity(baseRemote, root),
    worktree: git(root, ["rev-parse", "--show-toplevel"]),
  };
  repositoryCache.set(cwd, facts);
  return facts;
}

function provider(value: string): MeshProvider | undefined {
  return ["claude", "codex", "cursor", "grok"].includes(value)
    ? value as MeshProvider
    : undefined;
}

function taskState(session: SessionInfo): TaskState {
  if (session.state === "waiting") return "needs_user";
  if (session.state === "working") return "working";
  return "planned";
}

export function linkSessionsToProjects(
  store: MeshStore,
  sessions: SessionInfo[],
  computerId: string,
  inspect: (cwd: string) => RepositoryFacts = inspectRepository,
): SessionInfo[] {
  return sessions.map((session) => {
    const agent = provider(session.agent);
    const cwd = session.cwd?.trim();
    if (!agent || !cwd) return session;
    const repository = inspect(cwd);
    const projectId = projectIdentity(repository.canonicalRepositoryId);
    const project: Project = {
      projectId,
      name: basename(repository.root) || "Project",
      repositoryRoot: repository.root,
      canonicalRepositoryId: repository.canonicalRepositoryId,
      baseRemote: repository.baseRemote,
      createdAt: session.startedAt,
    };
    store.upsertProject(project);
    const knownTask = store.taskForExecution(computerId, agent, session.sessionId);
    const taskId = knownTask ?? taskIdentity(projectId, agent, session.sessionId);
    const task: MeshTask = {
      taskId,
      projectId,
      title: (session.title ?? session.summary ?? `${agent} task`).slice(0, 160),
      goal: (session.summary ?? session.title ?? "Continue this coding task").slice(0, 1_000),
      state: taskState(session),
      ownerSessionId: session.sessionId,
      createdAt: session.startedAt,
      updatedAt: session.lastActivityAt,
    };
    store.upsertTask(task);
    store.linkExecution({
      taskId,
      sessionId: session.sessionId,
      provider: agent,
      computerId,
      workspace: cwd,
      branch: session.branch,
      worktree: repository.worktree,
      startedAt: session.startedAt,
    });
    return { ...session, projectId, taskId, computerId, worktree: repository.worktree };
  });
}
