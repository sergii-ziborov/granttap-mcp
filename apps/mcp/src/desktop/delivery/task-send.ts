import { join } from "node:path";
import { configDir, loadRuntimeConfig } from "../../../../bridge/src/config";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";
import { deliverToSession } from "../../../../bridge/src/reply";
import type { CodingAgent, SessionInfo } from "../../../../../packages/protocol/schema";
import { readDesktopAttachments } from "./attachments";

type Delivery = typeof deliverToSession;
const pending = new Map<string, Promise<unknown>>();

/** A local person's turn is admitted only for an exact persisted Mesh Task execution. */
export function desktopTaskSend(input: unknown,
  storePath = join(configDir(), "project-mesh.json"), deliver: Delivery = deliverToSession,
): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return Promise.resolve(undefined);
  const query = input as Record<string, unknown>;
  const { project_id: projectId, task_id: taskId, session_id: sessionId,
    delivery_id: deliveryId, text } = query;
  if (typeof projectId !== "string" || !projectId || projectId.length > 128
    || typeof taskId !== "string" || !taskId || taskId.length > 128
    || typeof sessionId !== "string" || !sessionId || sessionId.length > 128
    || typeof deliveryId !== "string" || !/^[0-9a-f-]{36}$/i.test(deliveryId)
    || typeof text !== "string" || (!text.trim() && query.attachments_json === undefined) || text.length > 8_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    return Promise.resolve(undefined);
  }
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok") return Promise.resolve(undefined);
  const task = loaded.state.tasks.find((item) => item.taskId === taskId);
  const execution = loaded.state.executions.find((item) =>
    item.taskId === taskId && item.sessionId === sessionId);
  if (task?.projectId !== projectId || !execution || !execution.workspace
    || !["claude", "codex", "cursor", "grok"].includes(execution.provider)) {
    return Promise.resolve(undefined);
  }
  const provider = execution.provider as CodingAgent;
  if (loadRuntimeConfig().providerSettings[provider] === false) {
    return Promise.resolve({ operation: "desktop.task_send", accepted: false,
      error: "This agent is disabled in GrantTap Settings." });
  }
  const key = `${projectId}:${taskId}:${sessionId}:${deliveryId}`;
  const prior = pending.get(key);
  if (prior) return prior;
  const attachments = readDesktopAttachments(query.attachments_json);
  if (!attachments || !text.trim() && attachments.length === 0) return Promise.resolve(undefined);
  const session: SessionInfo = {
    sessionId, agent: provider, cwd: execution.workspace,
    state: execution.endedAt == null ? "working" : "idle",
    startedAt: execution.startedAt,
    lastActivityAt: execution.activeAt ?? execution.updatedAt ?? execution.startedAt,
    tokensSession: 0, tokensLastTurn: 0,
  };
  const operation = deliver(session, text.trim(), 240_000, attachments).then((result) => ({
    operation: "desktop.task_send", accepted: result.ok,
    error: result.ok ? null : result.error.slice(0, 500),
  }), () => ({ operation: "desktop.task_send", accepted: false,
    error: "The provider did not complete this Task turn." }));
  pending.set(key, operation);
  if (pending.size > 128) pending.delete(pending.keys().next().value ?? "");
  return operation;
}
