import {
  ProjectBindingSummary,
  type ProjectBindingSummary as BindingValue,
} from "../../../../packages/protocol/schema";
import type { StoreState } from "./store-state";

export function bindingForRepository(
  bindings: BindingValue[],
  repositoryId: string,
  endpointId?: string,
): BindingValue | undefined {
  const exact = endpointId == null ? undefined : bindings.find((item) =>
    item.endpointId === endpointId && item.repositoryId === repositoryId);
  if (exact) return exact;
  const matches = bindings.filter((item) => item.repositoryId === repositoryId);
  const projects = new Set(matches.map((item) => item.projectId));
  return projects.size === 1 ? matches[0] : undefined;
}

export function upsertBinding(
  state: StoreState,
  input: BindingValue,
): { bindings: BindingValue[]; changed: boolean } {
  const binding = ProjectBindingSummary.parse(input);
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
  if (computerId != null) return local?.worktree ?? local?.workspace;
  return local?.worktree ?? local?.workspace
    ?? state.projects.find((item) => projectIds.has(item.projectId))?.repositoryRoot;
}
