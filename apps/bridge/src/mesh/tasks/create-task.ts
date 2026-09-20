import { inspectRepository } from "../catalog";
import { computerId } from "../identity/computer";
import { admitNewTask, loadExecutionPolicy } from "../runtime/execution-policy";
import { localMeshStore } from "../local-remote/local";
import { allowedModelIds, catalogFromSessions } from "../catalog/models";
import { scanSessionHistory, scanSessions } from "../../sessions";

const DETAILS = {
  unknown_workspace: "That project folder is not one of the agent workspaces currently advertised to this phone.",
  not_confirmed: "The pinned host has not confirmed this Project yet.",
  wrong_host: "This Project is pinned to another computer. GrantTap will not start the task here.",
  host_offline: "The pinned host is offline.",
  host_unavailable: "The pinned host grant was withdrawn.",
  model_not_allowed: "That model is not in the pinned host catalog.",
  no_project_binding: "This computer has no Project binding for that folder.",
  wrong_project: "That folder belongs to a different Project on this computer.",
} as const;

export type CreateTaskEvaluation =
  | { ok: true; projectId?: string }
  | { ok: true; queued: true; deadline: number; projectId: string }
  | { ok: false; reason: keyof typeof DETAILS; detail: string };

/**
 * An explicit projectId may only use this endpoint's own binding.
 * Another computer's row can name the Project for discovery; it cannot admit
 * a create here.
 */
export function resolveCreateTaskProject(input: {
  requestedProjectId?: string;
  endpointBinding?: { projectId: string };
  inferredProjectId?: string;
}): CreateTaskEvaluation {
  const requested = input.requestedProjectId?.trim();
  if (requested) {
    if (!input.endpointBinding) {
      return { ok: false, reason: "no_project_binding", detail: DETAILS.no_project_binding };
    }
    if (input.endpointBinding.projectId !== requested) {
      return { ok: false, reason: "wrong_project", detail: DETAILS.wrong_project };
    }
    return { ok: true, projectId: requested };
  }
  return { ok: true, projectId: input.inferredProjectId };
}

export function evaluateCreateTask(input: {
  cwd: string;
  agent: string;
  model?: string;
  projectId?: string;
  localEndpointId?: string;
  hostOnline?: boolean;
  now?: number;
}): CreateTaskEvaluation {
  const endpoint = input.localEndpointId ?? computerId();
  const known = [...scanSessions().sessions, ...scanSessionHistory()].some((session) =>
    session.agent === input.agent && session.cwd === input.cwd);
  if (!known) return { ok: false, reason: "unknown_workspace", detail: DETAILS.unknown_workspace };
  const repository = inspectRepository(input.cwd);
  const store = localMeshStore();
  const resolved = resolveCreateTaskProject({
    requestedProjectId: input.projectId,
    endpointBinding: store.bindingForEndpoint(repository.canonicalRepositoryId, endpoint),
    inferredProjectId: store.projectIdForRepository(repository.canonicalRepositoryId, endpoint),
  });
  if (!resolved.ok) return resolved;
  const projectId = resolved.projectId;
  const policy = projectId ? loadExecutionPolicy(projectId) : undefined;
  const catalog = catalogFromSessions(endpoint, scanSessions().sessions);
  const admitted = admitNewTask({
    policy,
    localEndpointId: endpoint,
    hostOnline: input.hostOnline ?? true,
    model: input.model,
    allowedModels: allowedModelIds(catalog, undefined),
    now: input.now,
  });
  if (!admitted.ok) return { ok: false, reason: admitted.reason, detail: DETAILS[admitted.reason] };
  if ("queued" in admitted && admitted.queued) {
    return { ok: true, queued: true, deadline: admitted.deadline, projectId: projectId ?? "" };
  }
  return { ok: true, projectId };
}
