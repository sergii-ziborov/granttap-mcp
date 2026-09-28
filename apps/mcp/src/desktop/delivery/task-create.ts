import { realpathSync } from "node:fs";
import { join } from "node:path";
import { configDir, loadRuntimeConfig } from "../../../../bridge/src/config";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";
import { inspectRepository } from "../../../../bridge/src/mesh/catalog";
import { computerId } from "../../../../bridge/src/mesh/identity/computer";
import { readDesktopAttachments } from "./attachments";
import { admitNewTask, loadExecutionPolicy } from "../../../../bridge/src/mesh/runtime/execution-policy";
import {
  createClaudeSession, createCodexSession, createCursorSession, createGrokSession,
} from "../../../../bridge/src/reply";

const providers = {
  claude: createClaudeSession, codex: createCodexSession,
  cursor: createCursorSession, grok: createGrokSession,
};
type Provider = keyof typeof providers;
type Creator = typeof createCodexSession;
const pending = new Map<string, Promise<unknown>>();

/** Start a native provider Task only in an exact local Mesh repository binding. */
export function desktopTaskCreate(
  input: unknown,
  storePath = join(configDir(), "project-mesh.json"),
  endpoint = computerId(),
  create?: Creator,
  enabled: (agent: Provider) => boolean = (agent) =>
    loadRuntimeConfig().providerSettings[agent] !== false,
): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return Promise.resolve(undefined);
  const query = input as Record<string, unknown>;
  const projectId = query.project_id, bindingId = query.binding_id;
  const operationId = query.operation_id, text = query.text;
  const provider = query.provider, model = query.model;
  if (typeof projectId !== "string" || !projectId || projectId.length > 128
    || typeof bindingId !== "string" || !bindingId || bindingId.length > 128
    || query.endpoint_id !== endpoint
    || typeof operationId !== "string" || !/^[0-9a-f-]{36}$/i.test(operationId)
    || typeof text !== "string" || (!text.trim() && query.attachments_json === undefined) || text.length > 8_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
    || typeof provider !== "string" || !(provider in providers)
    || model !== undefined && (typeof model !== "string" || model.length > 128)) {
    return Promise.resolve(undefined);
  }
  const loaded = readStoreState(storePath);
  const binding = loaded.status === "ok"
    ? loaded.state.bindings.find((row) => row.bindingId === bindingId
      && row.projectId === projectId && row.endpointId === endpoint && row.available)
    : undefined;
  if (!binding?.localPathHint || !loaded.state.projects.some(
    (project) => project.projectId === projectId
  )) return Promise.resolve({ operation: "desktop.task_create", created: false,
    error: "This repository is not available in this Mesh on this Mac." });
  let workspace: string;
  try {
    workspace = realpathSync(binding.localPathHint);
    if (inspectRepository(workspace).canonicalRepositoryId !== binding.repositoryId) {
      throw new Error("Repository identity changed");
    }
  } catch {
    return Promise.resolve({ operation: "desktop.task_create", created: false,
      error: "The bound repository is no longer available at this path." });
  }
  const agent = provider as Provider;
  if (!enabled(agent)) {
    return Promise.resolve({ operation: "desktop.task_create", created: false,
      error: "This agent is disabled in GrantTap Settings." });
  }
  let admitted;
  try {
    admitted = admitNewTask({
      policy: loadExecutionPolicy(projectId), localEndpointId: endpoint,
      requestedEndpointId: endpoint, hostOnline: true,
    });
  } catch {
    return Promise.resolve({ operation: "desktop.task_create", created: false,
      error: "This Mesh's execution policy is unavailable." });
  }
  if (!admitted.ok || "queued" in admitted && admitted.queued) {
    return Promise.resolve({ operation: "desktop.task_create", created: false,
      error: "This Mesh does not allow a new Task on this Mac." });
  }
  const prior = pending.get(operationId);
  if (prior) return prior;
  const attachments = readDesktopAttachments(query.attachments_json);
  if (!attachments || !text.trim() && attachments.length === 0) return Promise.resolve(undefined);
  const start = create ?? providers[agent];
  const result = start(text.trim(), workspace, 240_000, attachments, model as string | undefined,
    operationId).then((reply) => ({
      operation: "desktop.task_create", created: reply.ok,
      session_id: reply.ok ? reply.sessionId ?? null : null,
      error: reply.ok ? null : reply.error.slice(0, 500),
    }), () => ({ operation: "desktop.task_create", created: false,
      session_id: null, error: "The provider could not start this Task." }));
  pending.set(operationId, result);
  if (pending.size > 128) pending.delete(pending.keys().next().value ?? "");
  return result;
}
