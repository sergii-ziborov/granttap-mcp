import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type {
  MeshProvider,
  MeshTask,
  Project,
  SessionInfo,
  TaskState,
} from "../../../../../packages/protocol/schema";
import {
  canonicalRepositoryIdentity,
  projectBindingIdentity,
  projectIdentity,
  sanitizedRepositoryRemote,
  taskIdentity,
} from "../identity";
import { formerComputerNames } from "../identity/computer";
import { readIntegrationMap } from "../observed/integration-map";
import type { MeshStore } from "../store";
import { folderMeshHoldsRemote } from "../local-remote/folder-meshes";
import { queueProjectBindingSync } from "../../engine/runtime/engine-projects";
import { isCursorTaskCloneId } from "../../sessions/cursor/catalog";
import { localTaskTransfers } from '../../task-transfer';
import { helperRunFolder } from '../../helper-runs';
import { childrenLast, inheritsParentMesh, parentPlacement, type MeshPlacement } from '../../started-by/mesh';
import { presentableTitle } from '../../sessions/support/activity-helpers';
export { inspectRepositoryAsync, inspectWorkingTreeAsync, readRepositoryGit } from "./repository-inspection";
export { prepareMonitorInspection } from "./monitor-inspection";
import type { CatalogInspection } from "./monitor-inspection";
export type { CatalogInspection } from "./monitor-inspection";

export type RepositoryFacts = {
  root: string;
  canonicalRepositoryId: string;
  baseRemote?: string;
  worktree?: string;
  revision?: string;
  branch?: string;
};

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
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  const rawRemote = git(root, ["remote", "get-url", "origin"]);
  const baseRemote = rawRemote ? sanitizedRepositoryRemote(rawRemote) : undefined;
  const facts = {
    root,
    baseRemote,
    canonicalRepositoryId: canonicalRepositoryIdentity(rawRemote, root),
    worktree: git(root, ["rev-parse", "--show-toplevel"]),
    revision: git(root, ["rev-parse", "HEAD"]),
    branch: git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  };
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
  const named = presentableTitle(session.title);
  if (named) return named;
  const opening = session.summary
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (opening ?? `${agent} task`).slice(0, 160);
}

/**
 * A chat with no request and no answer yet names no Task: it is not linked until one appears.
 * Earlier runtimes made such Tasks anyway; snapshots leave them out (`requestlessTask`).
 */
export function hasTaskSubject(session: SessionInfo): boolean {
  return Boolean(presentableTitle(session.title) || session.summary?.trim());
}

/** The chat's newest message, else its request; `hasTaskSubject` holds, so one of them has words. */
function taskGoal(session: SessionInfo): string {
  const goal = session.summary?.trim() ? session.summary : presentableTitle(session.title) ? session.title : undefined;
  return (goal ?? "").slice(0, 1_000);
}

function taskState(session: SessionInfo): TaskState {
  if (session.state === "waiting") return "needs_user";
  if (session.state === "working") return "working";
  // Its turn ended on the provider's error (a used-up limit): nothing goes on until something changes.
  if (session.stopped) return "blocked";
  return "planned";
}

export function linkSessionsToProjects(
  store: MeshStore,
  sessions: SessionInfo[],
  computerId: string,
  inspect: ((cwd: string) => RepositoryFacts) | CatalogInspection = inspectRepository,
  formerNames: string[] = formerComputerNames(),
): SessionInfo[] {
  localTaskTransfers().reconcileCatalogOwnership(store, computerId);
  // Records kept under a name this computer used to go by are this computer's
  // leftovers, not a second machine: their executions are over and their
  // bindings unavailable.
  store.retireComputerNames(computerId, formerNames);
  // Task-tool clones are the parent chat's work. Linking them minted a Task
  // per spawn, and the phone then kept those Tasks forever.
  const visible = sessions.filter((session) => !isCursorTaskCloneId(session.sessionId));
  // A vanished session never says it ended, so sweep first: an execution left
  // open holds the Task, keeps its old title, and keeps its last state.
  store.closeVanishedExecutions(
    computerId,
    new Set(visible.map((session) => session.sessionId)),
    new Set(sessions.flatMap((session) => provider(session.agent) ?? [])),
  );
  // Share one consistent reading within this catalog batch, then discard it.
  // A new Git checkout or origin must be discovered on the next refresh.
  const repositories = new Map<string, RepositoryFacts>();
  const workingTrees = new Map<string, boolean | undefined>();
  const inspectWorkingTree = (cwd: string): boolean | undefined => {
    if (!workingTrees.has(cwd)) workingTrees.set(cwd, typeof inspect === "function"
      ? hasUncommittedWork(cwd) : inspect.workingTree(cwd));
    return workingTrees.get(cwd);
  };
  const inspectOnce = (cwd: string): RepositoryFacts => {
    let facts = repositories.get(cwd);
    if (!facts) {
      facts = typeof inspect === "function" ? inspect(cwd) : inspect.repository(cwd);
      repositories.set(cwd, facts);
    }
    return facts;
  };
  // A chat another chat started follows its parent into the parent's Mesh, so parents go first.
  const placed = new Map<string, MeshPlacement>();
  const linked: SessionInfo[] = [...visible];
  for (const index of childrenLast(visible)) {
    linked[index] = linkSession({ store, session: visible[index]!, computerId, inspect: inspectOnce, inspectWorkingTree, placed });
  }
  return linked;
}

type LinkInput = {
  store: MeshStore;
  session: SessionInfo;
  computerId: string;
  inspect: (cwd: string) => RepositoryFacts;
  inspectWorkingTree: (cwd: string) => boolean | undefined;
  /** Where this catalog put each chat so far, by provider and session. */
  placed: Map<string, MeshPlacement>;
};

function linkSession(input: LinkInput): SessionInfo {
  const { store, session, computerId, inspect } = input;
  const agent = provider(session.agent);
  const cwd = session.cwd?.trim();
  // A generator's throwaway folder is not a workspace: registering it minted a Mesh per run.
  if (!agent || !cwd || helperRunFolder(cwd) || !hasTaskSubject(session)) return session;
  const knownTaskId = store.taskForExecution(computerId, agent, session.sessionId);
  const knownProjectId = knownTaskId ? store.task(knownTaskId)?.projectId : undefined;
  const previous = knownProjectId ? store.snapshot(knownProjectId)?.executions.find(row =>
    row.taskId === knownTaskId && row.provider === agent && row.sessionId === session.sessionId
      && row.computerId === computerId && row.workspace === cwd) : undefined;
  let repository = inspect(session.worktree ?? cwd);
  if (!repository.worktree && previous?.worktree) {
    const retained = inspect(previous.worktree);
    if (retained.worktree && retained.revision
      && retained.canonicalRepositoryId === previous.repositoryId) repository = retained;
  }
  // A child in a folder that is no checkout of its own is its parent's work: no Mesh for its folder.
  if (inheritsParentMesh(session, repository)) return linkStartedChild(input, agent, cwd, knownTaskId);
  const projectId = (knownTaskId ? store.task(knownTaskId)?.projectId : undefined)
    ?? store.projectIdForRepository(repository.canonicalRepositoryId, computerId)
    ?? projectIdentity(repository.canonicalRepositoryId);
  const knownProject = store.project(projectId);
  const project = knownProject ?? {
    projectId,
    name: basename(repository.root) || "Project",
    repositoryRoot: repository.root,
    canonicalRepositoryId: repository.canonicalRepositoryId,
    baseRemote: repository.baseRemote
      ? sanitizedRepositoryRemote(repository.baseRemote)
      : undefined,
    createdAt: session.startedAt,
  };
  if (!knownProject) store.upsertProject(project);
  bindSessionRepository(store, project, repository, computerId, session.lastActivityAt);
  const taskId = knownTaskId ?? taskIdentity(projectId, agent, session.sessionId);
  const task: MeshTask = {
    taskId,
    projectId,
    title: meshTaskTitle(session, agent),
    goal: taskGoal(session),
    state: taskState(session),
    ownerSessionId: session.sessionId,
    createdAt: session.startedAt,
    updatedAt: session.lastActivityAt,
  };
  store.upsertTask(task);
  const repositoryId = repository.worktree ? repository.canonicalRepositoryId
    : previous?.repositoryId ?? repository.canonicalRepositoryId;
  input.placed.set(`${session.agent}\0${session.sessionId}`, { projectId, repositoryId });
  store.linkExecution({
    taskId,
    sessionId: session.sessionId,
    provider: agent,
    computerId,
    workspace: cwd,
    repositoryId,
    activeAt: session.lastActivityAt,
    state: session.state, continuedAt: session.transfer?.continuedAt,
    branch: repository.branch ?? session.branch,
    worktree: repository.worktree ?? previous?.worktree,
    uncommitted: input.inspectWorkingTree(repository.worktree ?? cwd),
    startedAt: session.startedAt,
  });
  return { ...session, projectId, taskId, computerId, worktree: repository.worktree ?? previous?.worktree };
}

/**
 * A chat another chat started, in a folder that is no checkout of its own, in its parent's Mesh. The
 * folder is bound to nothing. Without its parent's Mesh on this computer the child is in none.
 */
function linkStartedChild(input: LinkInput, agent: MeshProvider, cwd: string, knownTaskId: string | undefined): SessionInfo {
  const { store, session, computerId } = input;
  const parent = parentPlacement(session.startedBy!, input.placed, store, computerId);
  if (!parent) return session;
  const known = knownTaskId ? store.task(knownTaskId) : undefined;
  // A Task an older runtime made in a Mesh of the child's own folder stays there; the chat moves on.
  const taskId = known?.projectId === parent.projectId ? known.taskId : taskIdentity(parent.projectId, agent, session.sessionId);
  store.upsertTask({
    taskId, projectId: parent.projectId, title: meshTaskTitle(session, agent), goal: taskGoal(session),
    state: taskState(session), ownerSessionId: session.sessionId, createdAt: session.startedAt, updatedAt: session.lastActivityAt,
  });
  store.linkExecution({
    taskId, sessionId: session.sessionId, provider: agent, computerId, workspace: cwd,
    ...(parent.repositoryId ? { repositoryId: parent.repositoryId } : {}),
    activeAt: session.lastActivityAt, state: session.state, continuedAt: session.transfer?.continuedAt,
    branch: session.branch, startedAt: session.startedAt,
  });
  input.placed.set(`${session.agent}\0${session.sessionId}`, parent);
  return { ...session, projectId: parent.projectId, taskId, computerId };
}

/**
 * Bind the chat's checkout to its Project on this computer. A repository the
 * person took out of that Project here stays out, however many chats run in it.
 *
 * A repository with its own remote is never bound to a Mesh made for a folder
 * without Git: a task begun in `~/dev` that works in `~/dev/app` stays in the
 * folder Mesh with its history, and `app` keeps its own Mesh. A binding such a
 * task made before this rule is taken out of the folder Mesh, so the
 * repository's new chats, which already route past it, can bind it to its own.
 */
function bindSessionRepository(
  store: MeshStore, project: Project, repository: RepositoryFacts, computerId: string, lastSeenAt: number,
): void {
  const { projectId } = project;
  const repositoryId = repository.canonicalRepositoryId;
  if (folderMeshHoldsRemote(project, repositoryId)) {
    store.releaseFromFolderMesh(computerId, repositoryId);
    return;
  }
  if (store.bindingRemoved(projectId, computerId, repositoryId)) return;
  let knownBinding = store.bindingForEndpoint(repositoryId, computerId);
  if (knownBinding && knownBinding.projectId !== projectId
    && store.releaseFromFolderMesh(computerId, repositoryId)) knownBinding = undefined;
  const binding = {
    bindingId: knownBinding?.bindingId
      ?? projectBindingIdentity(projectId, computerId, repository.canonicalRepositoryId),
    projectId,
    endpointId: computerId,
    repositoryId: repository.canonicalRepositoryId,
    displayName: knownBinding?.displayName ?? (basename(repository.root) || "Repository"),
    localPathHint: repository.root,
    available: true,
    revision: repository.revision,
  };
  try {
    store.upsertBinding(binding);
    store.recordIntegrationPeers(
      projectId, repository.canonicalRepositoryId, readIntegrationMap(repository.root),
    );
    void queueProjectBindingSync(project, {
      summary: binding,
      localRoot: repository.root,
      canonicalRemote: repository.baseRemote
        ? sanitizedRepositoryRemote(repository.baseRemote)
        : undefined,
      lastSeenAt,
    });
  } catch {
    // Reported as an absent binding rather than an absent Mesh.
  }
}
