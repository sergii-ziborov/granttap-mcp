import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectExecutionPolicy } from "../../../../packages/protocol/schema";
import { configDir } from "../config/paths";
import { writePrivateFile } from "../config/write-private";
import { setRequireFreshCommands } from "../config-commands";

export type StoredExecutionPolicy = ProjectExecutionPolicy & { projectId: string };

type StoreFile = { policies: StoredExecutionPolicy[] };

export function executionPoliciesPath(): string {
  return join(configDir(), "execution-policies.json");
}

function loadAll(): StoredExecutionPolicy[] {
  try {
    const raw = JSON.parse(readFileSync(executionPoliciesPath(), "utf8")) as StoreFile;
    return Array.isArray(raw.policies) ? raw.policies : [];
  } catch {
    return [];
  }
}

function saveAll(policies: StoredExecutionPolicy[]): void {
  writePrivateFile(executionPoliciesPath(), `${JSON.stringify({ policies }, null, 2)}\n`);
  setRequireFreshCommands(policies.some((item) =>
    item.mode === "pinned" && item.hostGrantStatus === "applied"));
}

export function loadExecutionPolicy(projectId: string): StoredExecutionPolicy | undefined {
  return loadAll().find((item) => item.projectId === projectId);
}

export function rememberExecutionPolicy(
  projectId: string,
  execution: ProjectExecutionPolicy | undefined,
  localEndpointId: string,
): StoredExecutionPolicy | undefined {
  const policies = loadAll().filter((item) => item.projectId !== projectId);
  if (!execution) {
    saveAll(policies);
    return undefined;
  }
  const localHost = execution.mode === "pinned" && execution.targetEndpointId === localEndpointId;
  const stored: StoredExecutionPolicy = {
    ...execution,
    projectId,
    hostGrantStatus: localHost ? "applied" : execution.mode === "pinned" ? "pending" : "none",
    hostGrantId: localHost ? execution.hostGrantId ?? `grant:${localEndpointId}` : execution.hostGrantId,
  };
  saveAll([...policies, stored]);
  return stored;
}

export type TaskAdmission =
  | { ok: true }
  | { ok: true; queued: true; deadline: number }
  | { ok: false; reason: "not_confirmed" | "wrong_host" | "host_offline" | "host_unavailable" | "model_not_allowed" };

export function admitNewTask(input: {
  policy: StoredExecutionPolicy | undefined;
  localEndpointId: string;
  hostOnline: boolean;
  requestedEndpointId?: string;
  model?: string;
  allowedModels?: string[];
  now?: number;
}): TaskAdmission {
  const policy = input.policy;
  if (!policy || policy.mode === "distributed") return { ok: true };
  const target = policy.targetEndpointId;
  if (!target || target !== input.localEndpointId) return { ok: false, reason: "wrong_host" };
  if (policy.hostGrantStatus === "unavailable") return { ok: false, reason: "host_unavailable" };
  if (policy.hostGrantStatus !== "applied") return { ok: false, reason: "not_confirmed" };
  if (input.requestedEndpointId && input.requestedEndpointId !== target) {
    return { ok: false, reason: "wrong_host" };
  }
  if (!input.hostOnline) {
    if (policy.offlineBehavior === "queueUntilDeadline") {
      return { ok: true, queued: true, deadline: input.now ?? Date.now() };
    }
    return { ok: false, reason: "host_offline" };
  }
  if (input.model && input.allowedModels && !input.allowedModels.includes(input.model)) {
    return { ok: false, reason: "model_not_allowed" };
  }
  return { ok: true };
}

export function applyHostGrant(
  projectId: string,
  grant: "applied" | "unavailable",
  revision: number,
  localEndpointId: string,
): StoredExecutionPolicy | undefined {
  const current = loadExecutionPolicy(projectId);
  if (!current || current.mode !== "pinned" || current.targetEndpointId !== localEndpointId) {
    return current;
  }
  if (current.revision !== revision) return current;
  const next: StoredExecutionPolicy = { ...current, hostGrantStatus: grant };
  const others = loadAll().filter((item) => item.projectId !== projectId);
  saveAll([...others, next]);
  return next;
}

export function revokeExecutionPolicy(projectId: string): StoredExecutionPolicy | undefined {
  const current = loadExecutionPolicy(projectId);
  if (!current) return undefined;
  const next: StoredExecutionPolicy = { ...current, hostGrantStatus: "unavailable" };
  const others = loadAll().filter((item) => item.projectId !== projectId);
  saveAll([...others, next]);
  return next;
}
