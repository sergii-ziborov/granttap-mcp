import { join } from "node:path";
import { configDir } from "../../../../bridge/src/config";
import { deliveryRoutingError } from "../../../../bridge/src/capabilities";
import { observedComputerId } from "../../../../bridge/src/mesh/identity/computer";
import { deliverToSession } from "../../../../bridge/src/reply";
import { UserMessage } from "../../../../../packages/protocol/schema";
import { readDesktopAttachments } from "./attachments";
import { localTaskSession } from "./task-scope";

type Delivery = typeof deliverToSession;
const pending = new Map<string, Promise<unknown>>();

/** A local person's turn is admitted only for an exact persisted Mesh Task execution. */
export function desktopTaskSend(input: unknown,
  storePath = join(configDir(), "project-mesh.json"), deliver: Delivery = deliverToSession,
  endpointId = observedComputerId(),
): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return Promise.resolve(undefined);
  const query = input as Record<string, unknown>;
  const { project_id: projectId, task_id: taskId, session_id: sessionId,
    delivery_id: deliveryId, text, model, effort } = query;
  if (typeof projectId !== "string" || !projectId || projectId.length > 128
    || typeof taskId !== "string" || !taskId || taskId.length > 128
    || typeof sessionId !== "string" || !sessionId || sessionId.length > 128
    || typeof deliveryId !== "string" || !/^[0-9a-f-]{36}$/i.test(deliveryId)
    || typeof text !== "string" || (!text.trim() && query.attachments_json === undefined) || text.length > 8_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
    || model !== undefined && (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model))) {
    return Promise.resolve(undefined);
  }
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort as string)) {
    return Promise.resolve(undefined);
  }
  const routing = UserMessage.pick({ preferredMcp: true, skill: true, permissionMode: true }).safeParse({
    preferredMcp: query.preferred_mcp, skill: query.skill, permissionMode: query.permission_mode,
  });
  if (!routing.success) return Promise.resolve(undefined);
  const session = localTaskSession(query, storePath, endpointId);
  if (!session) return Promise.resolve(undefined);
  const options = { ...Object.fromEntries(Object.entries(routing.data).filter(([, value]) => value !== undefined)),
    ...(model === undefined ? {} : { model: model as string }),
    ...(effort === undefined ? {} : { effort: effort as string }) };
  const routingError = deliveryRoutingError(session, options);
  if (routingError) return Promise.resolve({ operation: "desktop.task_send", accepted: false, error: routingError });
  const key = `${projectId}:${taskId}:${sessionId}:${deliveryId}`;
  const prior = pending.get(key);
  if (prior) return prior;
  const attachments = readDesktopAttachments(query.attachments_json);
  if (!attachments || !text.trim() && attachments.length === 0) return Promise.resolve(undefined);
  const operation = deliver(session, text.trim(), 240_000, attachments, { ...options, messageId: deliveryId }).then((result) => ({
    operation: "desktop.task_send", accepted: result.ok,
    error: result.ok ? null : result.error.slice(0, 500),
  }), () => ({ operation: "desktop.task_send", accepted: false,
    error: "The provider did not complete this Task turn." }));
  pending.set(key, operation);
  if (pending.size > 128) pending.delete(pending.keys().next().value ?? "");
  return operation;
}
