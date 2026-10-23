import { join } from "node:path";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { ProjectKnowledgeQuery } from "../../../../../packages/protocol/messages/mesh/knowledge/refresh";
import { configDir } from "../../config/runtime/paths";
import { EngineClient } from "../../engine/runtime/engine-client";
import { engineFeatureEnabled } from "../../engine/runtime/engine-supervisor";
import { projectKnowledge } from "../../engine/runtime/engine-memory";
import { sendProjectPayload } from "../../host/session-keys";
import { computerId } from "../identity/computer";
import { localMeshStore } from "../local-remote/local";
import { readProjectKnowledge } from "./read";

const engine = new EngineClient({ socketPath: join(configDir(), "engine.sock") });

export async function currentProjectKnowledge(query: ProjectKnowledgeQuery) {
  return readProjectKnowledge(query, {
    snapshot: projectId => localMeshStore().snapshot(projectId),
    endpointId: computerId(), now: Date.now,
    memory: projectId => projectKnowledge(projectId),
    history: async projectId => {
      if (!engineFeatureEnabled()) return undefined;
      const result = await engine.request({ operation: "invocation.history",
        input: { project_id: projectId, tail: true, limit: 32 } }, { timeoutMs: 1_000 });
      return result.operation === "invocation.history" ? result.page : undefined;
    },
  });
}

export async function handleProjectKnowledgeQuery(
  client: RelayClient, query: ProjectKnowledgeQuery, peerPublicKey?: string,
): Promise<boolean> {
  if (!peerPublicKey) return false;
  const page = await currentProjectKnowledge(query);
  if (!page) return false;
  if (page.memoryAvailability === "ready") {
    localMeshStore().cacheKnowledge(page.projectId, page.knowledge);
  }
  await sendProjectPayload(client, page, "phone", {
    peerPublicKey, ttlMs: 15_000, reliable: false,
  }).catch(() => {});
  return true;
}

export async function desktopProjectKnowledge(input: unknown) {
  const value = input as { project_id?: unknown; request_id?: unknown } | undefined;
  const query = ProjectKnowledgeQuery.safeParse({ type: "mesh.knowledge.query",
    projectId: value?.project_id, sessionId: value?.project_id, requestId: value?.request_id });
  return query.success ? currentProjectKnowledge(query.data) : undefined;
}
