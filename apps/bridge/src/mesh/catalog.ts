import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type {
  MeshProvider,
  MeshTask,
  Project,
  SessionInfo,
  TaskState,
} from "../../../../packages/protocol/schema";
import {
  canonicalRepositoryIdentity,
  projectBindingIdentity,
  projectIdentity,
  sanitizedRepositoryRemote,
  taskIdentity,
} from "./identity";
import type { MeshStore } from "./store";
import { syncProjectBinding } from "../engine/engine-projects";

export type RepositoryFacts = {
  root: string;
  canonicalRepositoryId: string;
  baseRemote?: string;
  worktree?: string;
  revision?: string;
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

/**
 * Whether this checkout has anything a commit-based handoff would leave behind.
 *
 * `git status` rather than `git diff HEAD`, because an untracked file is work
 * the Task Capsule cannot carry just as surely as a modified tracked one.
 * `undefined` means the probe could not answer, which callers must not read as
 * "clean".
 */
export function hasUncommittedWork(cwd: string): boolean | undefined {
  try {
    const status = execFileSync(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=normal", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
        maxBuffer: 4 * 1_024 * 1_024 },
    );
    return status.trim().length > 0;
  } catch {
    return undefined;
  }
}

/** The same reading in the explicit form a Task Capsule publishes. */
export function workingTreeState(cwd: string): "clean" | "dirty" | "unknown" {
  const uncommitted = hasUncommittedWork(cwd);
  if (uncommitted === undefined) return "unknown";
  return uncommitted ? "dirty" : "clean";
}

export function inspectRepository(cwd: string): RepositoryFacts {
  const cached = repositoryCache.get(cwd);
  if (cached) return cached;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  const rawRemote = git(root, ["remote", "get-url", "origin"]);
  const baseRemote = rawRemote ? sanitizedRepositoryRemote(rawRemote) : undefined;
  const facts = {
    root,
    baseRemote,
    canonicalRepositoryId: canonicalRepositoryIdentity(rawRemote, root),
    worktree: git(root, ["rev-parse", "--show-toplevel"]),
    revision: git(root, ["rev-parse", "HEAD"]),
  };
  repositoryCache.set(cwd, facts);
  return facts;
}

function provider(value: string): MeshProvider | undefined {
  return ["claude", "codex", "cursor", "grok"].includes(value)
    ? value as MeshProvider
    : undefined;
}

/**
 * What to call a Task in a list that spans machines.
 *
 * The chat's own title is what a person recognises. An agent summary is a
 * paragraph about the work, and publishing it verbatim named Tasks with the
 * opening message — so the same chat read one way in the list of live chats and
 * another in the Project. Only its first line is a candidate for a name, and
 * even that is the fallback.
 */
export function meshTaskTitle(session: SessionInfo, agent: string): string {
  const named = session.title?.trim();
  if (named) return named.slice(0, 160);
  const opening = session.summary
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (opening ?? `${agent} task`).slice(0, 160);
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
  // A vanished session never says it ended, so sweep first: an execution left
  // open holds the Task, keeps its old title, and keeps its last state.
  store.closeVanishedExecutions(
    computerId,
    new Set(sessions.map((session) => session.sessionId)),
    new Set(sessions.flatMap((session) => provider(session.agent) ?? [])),
  );
  return sessions.map((session) => {
    const agent = provider(session.agent);
    const cwd = session.cwd?.trim();
    if (!agent || !cwd) return session;
    const repository = inspect(cwd);
    const projectId = store.projectIdForRepository(
      repository.canonicalRepositoryId,
      computerId,
    ) ?? projectIdentity(repository.canonicalRepositoryId);
    const knownProject = store.project(projectId);
    let project = knownProject;
    if (!project) {
      project = {
        projectId,
        name: basename(repository.root) || "Project",
        repositoryRoot: repository.root,
        canonicalRepositoryId: repository.canonicalRepositoryId,
        baseRemote: repository.baseRemote
          ? sanitizedRepositoryRemote(repository.baseRemote)
          : undefined,
        createdAt: session.startedAt,
      };
      store.upsertProject(project);
    }
    // Identity comes from this endpoint's own row. Another computer's binding
    // answers which Project the repository belongs to, but adopting its
    // `bindingId` would write a row whose stable key is owned elsewhere, and
    // the store rejects that — which is how a second computer joining a Project
    // once silenced repository bindings on the first one entirely.
    const knownBinding = store.bindingForEndpoint(repository.canonicalRepositoryId, computerId);
    const binding = {
      bindingId: knownBinding?.bindingId
        ?? projectBindingIdentity(projectId, computerId, repository.canonicalRepositoryId),
      projectId,
      endpointId: computerId,
      repositoryId: repository.canonicalRepositoryId,
      displayName: knownBinding?.displayName ?? (basename(repository.root) || "Repository"),
      available: true,
      revision: repository.revision,
    };
    // A binding the store refuses is one repository going unreported. It must
    // not also cost the Task, the execution, and every other session in the
    // same pass, which is what an escaping throw did.
    try {
      store.upsertBinding(binding);
      void syncProjectBinding(project, {
        summary: binding,
        localRoot: repository.root,
        canonicalRemote: repository.baseRemote
          ? sanitizedRepositoryRemote(repository.baseRemote)
          : undefined,
        lastSeenAt: session.lastActivityAt,
      });
    } catch {
      // Reported as an absent binding rather than an absent Mesh.
    }
    const knownTask = store.taskForExecution(computerId, agent, session.sessionId);
    const taskId = knownTask ?? taskIdentity(projectId, agent, session.sessionId);
    const task: MeshTask = {
      taskId,
      projectId,
      title: meshTaskTitle(session, agent),
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
      uncommitted: hasUncommittedWork(repository.worktree ?? cwd),
      startedAt: session.startedAt,
    });
    return { ...session, projectId, taskId, computerId, worktree: repository.worktree };
  });
}
