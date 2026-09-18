import { inspectRepository } from "./catalog";
import { computerId } from "./computer-identity";
import { admitNewTask, loadExecutionPolicy } from "./execution-policy";
import { localMeshStore } from "./local";
import { allowedModelIds, catalogFromSessions } from "./model-catalog";
import { scanSessionHistory, scanSessions } from "../sessions";

const DETAILS = {
  unknown_workspace: "That project folder is not one of the agent workspaces currently advertised to this phone.",
  not_confirmed: "The pinned host has not confirmed this Project yet.",
  wrong_host: "This Project is pinned to another computer. GrantTap will not start the task here.",
  host_offline: "The pinned host is offline.",
  host_unavailable: "The pinned host grant was withdrawn.",
  model_not_allowed: "That model is not in the pinned host catalog.",
} as const;

export type CreateTaskEvaluation =
  | { ok: true; projectId?: string }
  | { ok: true; queued: true; deadline: number; projectId: string }
  | { ok: false; reason: keyof typeof DETAILS; detail: string };

export function evaluateCreateTask(input: {
  cwd: string;
  agent: string;
  model?: string;
  localEndpointId?: string;
  hostOnline?: boolean;
  now?: number;
}): CreateTaskEvaluation {
  const endpoint = input.localEndpointId ?? computerId();
  const known = [...scanSessions().sessions, ...scanSessionHistory()].some((session) =>
    session.agent === input.agent && session.cwd === input.cwd);
  if (!known) return { ok: false, reason: "unknown_workspace", detail: DETAILS.unknown_workspace };
  const repository = inspectRepository(input.cwd);
  const projectId = localMeshStore().projectIdForRepository(repository.canonicalRepositoryId, endpoint);
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
