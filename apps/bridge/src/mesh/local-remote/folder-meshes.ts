/**
 * Meshes made for a folder without Git, and the repositories with a remote of their own that come
 * near them.
 *
 * A folder Mesh is named by its folder (`local:<path>`). A repository that has its own remote has a
 * Mesh of its own: a folder Mesh neither binds it nor routes its chats, whichever task first worked
 * in it from the folder. A folder that has since become a checkout of such a repository leaves its
 * old Mesh behind: that Mesh keeps its tasks, and is reported as superseded by the repository's Mesh.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ExecutionSessionLink,
  MeshTask,
  Project,
} from "../../../../../packages/protocol/schema";

const FOLDER = "local:";

export function folderIdentity(repositoryId: string): boolean {
  return repositoryId.startsWith(FOLDER);
}

/** Whether `project` is a folder Mesh and `repositoryId` a repository with its own remote. */
export function folderMeshHoldsRemote(project: Pick<Project, "canonicalRepositoryId"> | undefined,
  repositoryId: string): boolean {
  return !!project && folderIdentity(project.canonicalRepositoryId) && !folderIdentity(repositoryId);
}

type Facts = { projects: readonly Project[]; tasks: readonly MeshTask[]; executions: readonly ExecutionSessionLink[] };

/**
 * The Mesh that took over a folder Mesh's folder: the folder is a Git checkout now, and chats run
 * at its root in a repository with its own remote, in that repository's Mesh. The most recent such
 * chat names it. Undefined for a repository Mesh, and for a folder that is still a plain folder.
 */
export function supersedingProject(project: Project, facts: Facts,
  isCheckout: (folder: string) => boolean = folder => existsSync(join(folder, ".git"))): string | undefined {
  if (!folderIdentity(project.canonicalRepositoryId)) return undefined;
  const folders = new Set([project.canonicalRepositoryId.slice(FOLDER.length), project.repositoryRoot]
    .filter((folder): folder is string => !!folder));
  if (![...folders].some(isCheckout)) return undefined;
  const projectOf = new Map(facts.tasks.map((task) => [task.taskId, task.projectId]));
  const owners = new Map(facts.projects.map((item) => [item.projectId, item]));
  const latest = facts.executions
    .filter((row) => row.worktree && folders.has(row.worktree) && row.repositoryId && !folderIdentity(row.repositoryId))
    .flatMap((row) => {
      const projectId = projectOf.get(row.taskId);
      const owner = projectId ? owners.get(projectId) : undefined;
      return owner && owner.projectId !== project.projectId && !folderIdentity(owner.canonicalRepositoryId)
        ? [{ projectId: owner.projectId, at: row.activeAt ?? 0 }] : [];
    })
    .sort((left, right) => right.at - left.at)[0];
  return latest?.projectId;
}
