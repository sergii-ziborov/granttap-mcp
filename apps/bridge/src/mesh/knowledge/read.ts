import type { MeshSnapshot, ProjectKnowledgeRecord } from "../../../../../packages/protocol/schema";
import { ProjectKnowledgePage, ProjectKnowledgeQuery } from "../../../../../packages/protocol/messages/mesh/knowledge/refresh";
import type { InvocationHistoryPage } from "../../engine/protocol/engine-invocation-protocol";
import { activeProjectKnowledge, supersededProjectKnowledgeIds } from "./active";

export type KnowledgeReadDependencies = {
  snapshot: (projectId: string) => MeshSnapshot | undefined;
  memory: (projectId: string) => Promise<ProjectKnowledgeRecord[] | undefined>;
  history: (projectId: string) => Promise<InvocationHistoryPage | undefined>;
  endpointId: string;
  now: () => number;
  timeoutMs?: number;
};

export async function readProjectKnowledge(
  query: ProjectKnowledgeQuery, dependencies: KnowledgeReadDependencies,
): Promise<ProjectKnowledgePage | undefined> {
  if (!ProjectKnowledgeQuery.safeParse(query).success) return undefined;
  const snapshot = dependencies.snapshot(query.projectId);
  if (!snapshot || snapshot.projectId !== query.projectId) return undefined;
  const timeout = dependencies.timeoutMs ?? 2_000;
  let [memory, history] = await Promise.all([
    boundedSource(() => dependencies.memory(query.projectId), timeout),
    boundedSource(() => dependencies.history(query.projectId), timeout),
  ]);
  if (memory?.some(record => record.projectId !== query.projectId || record.visibility !== "project")) {
    memory = undefined;
  }
  if (history?.events.some(row => row.event.project_id !== query.projectId)) history = undefined;
  const records = memory ?? [];
  const knowledge = activeProjectKnowledge(query.projectId, records)
    .sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 32);
  const invocations = (history?.events ?? []).slice(-32);
  const page: ProjectKnowledgePage = {
    type: "mesh.knowledge.page", sessionId: query.projectId, projectId: query.projectId,
    requestId: query.requestId, sourceEndpointId: dependencies.endpointId,
    memoryAvailability: memory ? "ready" : "unavailable",
    invocationAvailability: history ? "ready" : "unavailable",
    knowledge, invocations,
    supersededKnowledgeRecordIds: supersededProjectKnowledgeIds(query.projectId, records),
    incomplete: records.length > knowledge.length || history?.has_older === true
      || history?.has_more === true,
    generatedAt: dependencies.now(),
  };
  // Keep encrypted frames below the transport limit without shortening a fact.
  while (Buffer.byteLength(JSON.stringify(page)) > 128 * 1_024
    && (knowledge.length > 0 || invocations.length > 0)) {
    const oldestRecord = knowledge.at(-1)?.recordedAt ?? Infinity;
    const oldestCall = invocations[0]?.event.occurred_at ?? Infinity;
    if (oldestRecord <= oldestCall) knowledge.pop();
    else invocations.shift();
    page.incomplete = true;
  }
  return ProjectKnowledgePage.parse(page);
}

async function boundedSource<T>(read: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    })]);
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); }
}
