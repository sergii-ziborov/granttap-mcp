import { refreshLocalGraphBindings } from "../graph/binding-sync";
import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";
import {
  projectBackbone, projectRepositoryGraphs, waitForProjectBindingSync,
} from "../../../engine/runtime/engine-projects";
import { projectCortexIntegration } from "../../../cortex/integration";
import { projectKnowledge, queueProjectKnowledgeSync } from "../../../engine/runtime/engine-memory";
import { localMeshStore } from "../../local-remote/local";
import { activeProjectKnowledge, supersededProjectKnowledgeIds } from "../../knowledge/active";

/** The same Engine-backed projection for the phone publisher and local Mac reader. */
export async function enrichMeshSnapshot(
  snapshot: MeshSnapshot, options: { refreshGraph?: boolean } = {},
): Promise<MeshSnapshot> {
  const identityFailures = await refreshLocalGraphBindings(snapshot);
  const excludedRepositories = new Set(identityFailures.map((report) => report.repositoryId));
  const bindings = (snapshot.bindings ?? []).filter((binding) => !excludedRepositories.has(binding.repositoryId));
  await waitForProjectBindingSync(snapshot.projectId);
  queueProjectKnowledgeSync({
    projectId: snapshot.projectId,
    events: localMeshStore().historyEventsForProject(snapshot.projectId),
  });
  const [backbone, repositoryGraphs, knowledge] = await Promise.all([
    projectBackbone(snapshot.projectId),
    projectRepositoryGraphs(snapshot.projectId, bindings, {
      background: options.refreshGraph !== true,
      priority: snapshot.tasks.reduce((latest, task) => Math.max(latest, task.updatedAt), 0),
    }),
    projectKnowledge(snapshot.projectId),
  ]);
  const sharedKnowledge = knowledge?.filter((item) => item.visibility === "project");
  if (sharedKnowledge) localMeshStore().cacheKnowledge(snapshot.projectId, sharedKnowledge);
  const memoryRows = new Map((snapshot.knowledge ?? []).map((item) => [item.recordId, item]));
  for (const item of sharedKnowledge ?? []) memoryRows.set(item.recordId, item);
  const allMemory = [...memoryRows.values()];
  const correctedIds = [...new Set([
    ...(snapshot.supersededKnowledgeRecordIds ?? []),
    ...supersededProjectKnowledgeIds(snapshot.projectId, allMemory),
  ])].sort().slice(-128);
  const enriched = { ...snapshot, backbone, repositoryGraphs: [...repositoryGraphs, ...identityFailures],
    knowledge: activeProjectKnowledge(snapshot.projectId, allMemory)
      .sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 16),
    ...(correctedIds.length > 0 ? { supersededKnowledgeRecordIds: correctedIds } : {}) };
  const cortex = await projectCortexIntegration(enriched);
  return { ...enriched, cortex: [cortex] };
}
