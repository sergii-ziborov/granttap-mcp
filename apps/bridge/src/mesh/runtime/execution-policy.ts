import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectExecutionPolicy as ExecutionPolicySchema, type ProjectExecutionPolicy } from "../../../../../packages/protocol/schema";
import { configDir } from "../../config/runtime/paths";
import { writePrivateFile } from "../../config/access/write-private";
import { setRequireFreshCommands } from "../../config/commands";

export type StoredExecutionPolicy = ProjectExecutionPolicy & { projectId: string };

type StoreFile = { policies: StoredExecutionPolicy[] };
const STORE_MARKER = "execution-policies-v1\n";

export function executionPoliciesPath(): string {
  return join(configDir(), "execution-policies.json");
}

export class ExecutionPolicyStoreError extends Error {
  constructor() { super("Execution policy store is unreadable or invalid"); }
}

function markerPath(): string {
  return join(configDir(), "execution-policies.known");
}

function markerPresent(): boolean {
  const path = markerPath();
  try {
    if (!lstatSync(path).isFile() || readFileSync(path, "utf8") !== STORE_MARKER) {
      throw new ExecutionPolicyStoreError();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ExecutionPolicyStoreError();
  }
}

function ensureMarker(): void {
  if (markerPresent()) return;
  try { writePrivateFile(markerPath(), STORE_MARKER); }
  catch { throw new ExecutionPolicyStoreError(); }
}

function loadAll(): StoredExecutionPolicy[] {
  let contents: string;
  try {
    contents = readFileSync(executionPoliciesPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !markerPresent()) return [];
    throw new ExecutionPolicyStoreError();
  }
  // Migrate an existing store on first read. A later missing store is then a
  // failure, including when a crash occurs after recording the marker.
  ensureMarker();
  let raw: StoreFile;
  try { raw = JSON.parse(contents) as StoreFile; }
  catch { throw new ExecutionPolicyStoreError(); }
  if (!raw || !Array.isArray(raw.policies)) throw new ExecutionPolicyStoreError();
  const seen = new Set<string>();
  return raw.policies.map((item) => {
    if (!item || typeof item.projectId !== "string" || !item.projectId.trim()
      || seen.has(item.projectId)) throw new ExecutionPolicyStoreError();
    const { projectId, ...policy } = item;
    const parsed = ExecutionPolicySchema.safeParse(policy);
    if (!parsed.success) throw new ExecutionPolicyStoreError();
    seen.add(projectId);
    return { ...parsed.data, projectId };
  });
}

function saveAll(policies: StoredExecutionPolicy[]): void {
  ensureMarker();
  writePrivateFile(executionPoliciesPath(), `${JSON.stringify({ policies }, null, 2)}\n`);
  setRequireFreshCommands(policies.some((item) => item.mode === "pinned"));
}

export function loadExecutionPolicy(projectId: string): StoredExecutionPolicy | undefined {
  return loadAll().find((item) => item.projectId === projectId);
}

export function rememberExecutionPolicy(
  projectId: string,
  execution: ProjectExecutionPolicy | undefined,
  localEndpointId: string,
): StoredExecutionPolicy | undefined {
  const all = loadAll();
  const current = all.find((item) => item.projectId === projectId);
  const policies = all.filter((item) => item.projectId !== projectId);
  if (!execution) {
    saveAll(policies);
    return undefined;
  }
  const localHost = execution.mode === "pinned" && execution.targetEndpointId === localEndpointId;
  const sameGrant = localHost
    && current?.mode === "pinned"
    && current.targetEndpointId === execution.targetEndpointId
    && current.revision === execution.revision
    && (current.hostGrantStatus === "applied" || current.hostGrantStatus === "unavailable");
  const stored: StoredExecutionPolicy = {
    ...execution,
    projectId,
    hostGrantStatus: execution.mode === "pinned"
      ? sameGrant ? current.hostGrantStatus : "pending"
      : "none",
    hostGrantId: sameGrant ? current.hostGrantId : undefined,
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
  if (input.model && input.allowedModels && !input.allowedModels.includes(input.model)) {
    return { ok: false, reason: "model_not_allowed" };
  }
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
  const next: StoredExecutionPolicy = {
    ...current,
    hostGrantStatus: grant,
    hostGrantId: grant === "applied" ? current.hostGrantId ?? `grant:${localEndpointId}` : current.hostGrantId,
  };
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
