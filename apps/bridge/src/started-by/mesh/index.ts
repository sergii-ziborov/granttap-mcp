/**
 * The Mesh of a chat another chat started.
 *
 * A child whose folder is no checkout of its own (a temp folder, a plain folder without Git, one that
 * is gone, or a folder of its parent's checkout) is its parent's work: it goes to its parent's Mesh
 * and registers none for its folder. A child in a checkout of its own keeps that checkout's Mesh.
 * A Mesh an older runtime registered for such a folder, holding only chats other chats started, is
 * kept in the store and left out of this computer's Project lists, like a helper run's.
 */
import { existsSync } from "node:fs";
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { plainFolder } from "../../helper-runs/kinds";
import { startedByKey, startedChildSessionIds, type StartedBy } from "../links";

/** Where a chat was placed by this catalog, so a child it started can follow it there. */
export type MeshPlacement = { projectId: string; repositoryId?: string };

/** Whether a chat is a child working in a folder that is no checkout of its own. */
export function inheritsParentMesh(session: Pick<SessionInfo, "startedBy">, repository: { worktree?: string }): boolean {
  return session.startedBy != null && !repository.worktree;
}

type PlacementStore = {
  taskForExecution(computerId: string, provider: string, sessionId: string): string | undefined;
  task(taskId: string): { projectId: string } | undefined;
  project(projectId: string): { projectId: string; canonicalRepositoryId: string } | undefined;
};

/** The parent's Mesh: where this catalog just placed it, else where its Task already is on this computer. */
export function parentPlacement(parent: StartedBy, placed: ReadonlyMap<string, MeshPlacement>, store: PlacementStore,
  computerId: string): MeshPlacement | undefined {
  const here = placed.get(startedByKey(parent));
  if (here) return here;
  const taskId = store.taskForExecution(computerId, parent.agent, parent.sessionId);
  const projectId = taskId ? store.task(taskId)?.projectId : undefined;
  const project = projectId ? store.project(projectId) : undefined;
  return project ? { projectId: project.projectId, repositoryId: project.canonicalRepositoryId } : undefined;
}

/** Parents before the children they started, and a parent before its own parent's grandchildren. */
export function childrenLast<T extends Pick<SessionInfo, "startedBy" | "startedAt">>(sessions: readonly T[]): number[] {
  return sessions.map((session, index) => ({ session, index }))
    .sort((left, right) => Number(left.session.startedBy != null) - Number(right.session.startedBy != null)
      || (left.session.startedBy ? left.session.startedAt - right.session.startedAt : 0) || left.index - right.index)
    .map((item) => item.index);
}

const CHECK_AGAIN_MS = 60_000;
const checkouts = new Map<string, { at: number; own: boolean }>();

/** Whether a folder holds a Git checkout of its own; asked once a minute per folder. */
function checkoutOfItsOwn(folder: string, now = Date.now()): boolean {
  const known = checkouts.get(folder);
  if (known && now - known.at < CHECK_AGAIN_MS && now >= known.at) return known.own;
  let own = false;
  try { own = existsSync(`${folder}/.git`); } catch { /* A folder that cannot be read holds no checkout. */ }
  if (checkouts.size >= 4_096) checkouts.clear();
  checkouts.set(folder, { at: now, own });
  return own;
}

type ProjectRow = { projectId: string; repositoryRoot?: string; canonicalRepositoryId: string };

/**
 * The Meshes registered for a child chat's folder: no remote, no checkout of their own, and every chat
 * of every one of their Tasks known to have been started by another chat.
 */
export function startedChildrenProjects(
  projects: readonly ProjectRow[],
  tasks: readonly { taskId: string; projectId: string; ownerSessionId?: string }[],
  executions: readonly { taskId: string; sessionId: string }[],
  children: ReadonlySet<string> = startedChildSessionIds(),
  ownCheckout: (folder: string) => boolean = checkoutOfItsOwn,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (children.size === 0) return hidden;
  const local = new Set(projects.filter((project) => project.canonicalRepositoryId.startsWith("local:"))
    .map((project) => project.projectId));
  if (local.size === 0) return hidden;
  const sessions = new Map<string, Set<string>>();
  const projectOfTask = new Map<string, string>();
  for (const task of tasks) {
    if (!local.has(task.projectId)) continue;
    projectOfTask.set(task.taskId, task.projectId);
    const ids = sessions.get(task.projectId) ?? new Set<string>();
    if (task.ownerSessionId) ids.add(task.ownerSessionId);
    sessions.set(task.projectId, ids);
  }
  for (const execution of executions) {
    const projectId = projectOfTask.get(execution.taskId);
    if (projectId) sessions.get(projectId)!.add(execution.sessionId);
  }
  for (const project of projects) {
    const ids = sessions.get(project.projectId);
    if (!ids || ids.size === 0 || ![...ids].every((id) => children.has(id))) continue;
    const folders = [project.repositoryRoot, project.canonicalRepositoryId.slice("local:".length)]
      .flatMap((folder) => folder ? [folder, plainFolder(folder)] : []);
    if (!folders.some((folder) => ownCheckout(folder))) hidden.add(project.projectId);
  }
  return hidden;
}

/** For tests: look at every folder again. */
export function forgetCheckoutChecks(): void {
  checkouts.clear();
}
