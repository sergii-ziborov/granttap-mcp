import { join } from "node:path";
import type { MeshInvocationPage, MeshInvocationQuery } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { configDir } from "../../config/runtime/paths";
import { computerId } from "../../mesh/identity/computer";
import { localMeshStore } from "../../mesh/local-remote/local";
import { sendProjectPayload } from "../../host/session-keys";
import { EngineClient } from "../runtime/engine-client";
import { engineFeatureEnabled } from "../runtime/engine-supervisor";
import type { InvocationHistoryPage } from "../protocol/engine-invocation-protocol";

const engine = new EngineClient({ socketPath: join(configDir(), "engine.sock") });

export function invocationReply(
  query: MeshInvocationQuery, page: InvocationHistoryPage | undefined,
  endpointId: string, now: number,
): MeshInvocationPage {
  return {
    type: "mesh.invocation.page", sessionId: query.projectId,
    projectId: query.projectId, taskId: query.taskId, requestId: query.requestId,
    sourceEndpointId: endpointId, availability: page ? "ready" : "unavailable",
    events: page?.events ?? [],
    nextSequence: page?.next_sequence ?? query.afterSequence ?? 0,
    previousSequence: page?.previous_sequence ?? query.beforeSequence ?? 0,
    hasMore: page?.has_more ?? false, hasOlder: page?.has_older ?? false,
    generatedAt: now,
  };
}

export async function handleInvocationQuery(
  client: RelayClient, query: MeshInvocationQuery,
): Promise<boolean> {
  const project = localMeshStore().snapshot(query.projectId);
  if (!project?.tasks.some((task) => task.taskId === query.taskId)) return false;
  let page: InvocationHistoryPage | undefined;
  if (engineFeatureEnabled()) {
    try {
      const result = await engine.request({
        operation: "invocation.history",
        input: {
          project_id: query.projectId, task_id: query.taskId,
          after_sequence: query.afterSequence,
          before_sequence: query.beforeSequence,
          tail: query.tail ?? false, limit: query.limit ?? 16,
        },
      }, { timeoutMs: 1_000 });
      if (result.operation === "invocation.history") page = result.page;
    } catch { /* A missing or older Engine is shown as unavailable. */ }
  }
  await sendProjectPayload(client, invocationReply(query, page, computerId(), Date.now()),
    "phone", { ttlMs: 15 * 60_000 }).catch(() => {});
  return true;
}
