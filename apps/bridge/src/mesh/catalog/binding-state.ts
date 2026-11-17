import {
  ProjectBindingSummary,
  type Project as ProjectValue,
  type ProjectBindingSummary as BindingValue,
} from "../../../../../packages/protocol/schema";
import { bindingRemoved, type StoreState } from "../store/state";
import { folderMeshHoldsRemote } from "../local-remote/folder-meshes";

export { folderIdentity, folderMeshHoldsRemote } from "../local-remote/folder-meshes";

/**
 * The binding this endpoint owns for this repository, and nothing else.
 *
 * `bindingForRepository` deliberately falls back to a match on any endpoint so
 * a machine joining a Project can learn which Project a repository belongs to.
 * That answer must never be read as an identity: adopting another computer's
 * `bindingId` for a local endpoint writes a row whose stable key is already
 * owned elsewhere, which is a conflict the store rejects outright.
 */
export function bindingForEndpoint(
  bindings: BindingValue[],
  repositoryId: string,
  endpointId: string,
): BindingValue | undefined {
  return bindings.find((item) =>
    item.endpointId === endpointId && item.repositoryId === repositoryId);
}

/**
 * The binding that routes a repository's chats. Given the Projects, a folder Mesh's binding of a
 * repository with its own remote is passed over, so the repository's chats go to its own Mesh.
 */
export function bindingForRepository(
  allBindings: BindingValue[],
  repositoryId: string,
  endpointId?: string,
  knownProjects?: readonly ProjectValue[],
): BindingValue | undefined {
  const bindings = knownProjects ? allBindings.filter((item) => !folderMeshHoldsRemote(
    knownProjects.find((project) => project.projectId === item.projectId), item.repositoryId)) : allBindings;
  const exact = endpointId == null
    ? undefined
    : bindingForEndpoint(bindings, repositoryId, endpointId);
  if (exact) return exact;
  const matches = bindings.filter((item) => item.repositoryId === repositoryId);
  const projects = new Set(matches.map((item) => item.projectId));
  return projects.size === 1 ? matches[0] : undefined;
}

/** A binding the person removed on this computer is not bound again until they add it back. */
export function upsertBinding(
  state: StoreState,
  input: BindingValue,
): { bindings: BindingValue[]; changed: boolean } {
  const binding = ProjectBindingSummary.parse(input);
  if (bindingRemoved(state, binding)) return { bindings: state.bindings, changed: false };
  const stableConflict = state.bindings.some((item) =>
    item.bindingId === binding.bindingId
    && (item.projectId !== binding.projectId
      || item.endpointId !== binding.endpointId
      || item.repositoryId !== binding.repositoryId));
  const endpointConflict = state.bindings.some((item) =>
    item.bindingId !== binding.bindingId
    && item.endpointId === binding.endpointId
    && item.repositoryId === binding.repositoryId);
  if (stableConflict || endpointConflict) throw new Error("Project binding conflict");
  if (!state.projects.some((item) => item.projectId === binding.projectId)) {
    throw new Error("Binding Project does not exist");
  }
  const previous = state.bindings.find((item) => item.bindingId === binding.bindingId);
  if (previous && JSON.stringify(previous) === JSON.stringify(binding)) {
    return { bindings: state.bindings, changed: false };
  }
  const bindings = state.bindings.filter((item) => item.bindingId !== binding.bindingId);
  bindings.push(binding);
  bindings.sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  return { bindings, changed: true };
}

export function workspaceForRepository(
  state: StoreState,
  canonicalRepositoryId: string,
  computerId?: string,
): string | undefined {
  // A Project can contain several repositories. Its first execution may be
  // rooted in their parent folder, so an exact owned binding takes precedence.
  const binding = state.bindings.find(item => item.repositoryId === canonicalRepositoryId
    && item.available && (computerId == null || item.endpointId === computerId));
  if (binding?.localPathHint) return binding.localPathHint;
  const projectIds = new Set([
    ...state.bindings
      .filter((binding) => binding.repositoryId === canonicalRepositoryId)
      .map((binding) => binding.projectId),
    ...state.projects
      .filter((project) => project.canonicalRepositoryId === canonicalRepositoryId)
      .map((project) => project.projectId),
  ]);
  const taskIds = new Set(state.tasks
    .filter((task) => projectIds.has(task.projectId)).map((task) => task.taskId));
  const local = state.executions.find((item) =>
    taskIds.has(item.taskId) && (computerId == null || item.computerId === computerId));
  if (computerId != null) return local?.worktree ?? local?.workspace
    ?? state.bindings.find(binding => binding.endpointId === computerId
      && binding.repositoryId === canonicalRepositoryId && binding.available)?.localPathHint;
  return local?.worktree ?? local?.workspace
    ?? state.projects.find((item) => projectIds.has(item.projectId))?.repositoryRoot;
}
