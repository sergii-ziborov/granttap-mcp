import type {
  MeshSnapshot,
  ProjectCortexIntegration,
} from "../../../../packages/protocol/schema";
import type {
  EngineContextCompilation,
  EngineContextEvidence,
} from "../engine/protocol/engine-protocol";
import {
  compileProjectContext,
  projectEngineProvenance,
} from "../engine/runtime/engine-projects";
import type { ScopedMeshView } from "../mesh/snapshot/scoped-view";
import { loadRuntimeConfig } from "../config/runtime";
import { computerId } from "../mesh/identity/computer";
import { defaultCortexConfig } from "./config";

type CortexDependencies = {
  provenance?: typeof projectEngineProvenance;
  compile?: typeof compileProjectContext;
  now?: () => number;
};

export async function projectCortexIntegration(
  snapshot: MeshSnapshot,
  endpointId = computerId(),
  dependencies: CortexDependencies = {},
): Promise<ProjectCortexIntegration> {
  const projectId = snapshot.projectId;
  const config = loadRuntimeConfig().cortexByProject[projectId] ?? defaultCortexConfig();
  const checkedAt = (dependencies.now ?? Date.now)();
  const base = { projectId, endpointId, enabled: config.enabled, maxTokens: config.maxTokens, checkedAt };
  if (!config.enabled) return { ...base, state: "disabled" };
  const provenance = await (dependencies.provenance ?? projectEngineProvenance)();
  const loaded = {
    ...base,
    version: provenance?.cortexVersion,
    revision: provenance?.cortexRevision,
    weavatrixVersion: provenance?.weavatrixVersion,
  };
  if (!provenance) {
    return { ...loaded, state: "unavailable", detail: "GrantTap Engine is unavailable" };
  }
  const task = snapshot.tasks.find((value) => value.state === "working") ?? snapshot.tasks[0];
  if (!task) return { ...loaded, state: "loaded", detail: "No Task is available to compile" };
  const compilation = await (dependencies.compile ?? compileProjectContext)({
    projectId, taskId: task.taskId, maxTokens: config.maxTokens,
    evidence: cortexSnapshotEvidence(snapshot, task.taskId),
  });
  if (!compilation) {
    return { ...loaded, state: "unavailable", detail: "Cortex context compilation failed" };
  }
  const repositoryEvidenceMissing = (snapshot.bindings?.length ?? 0) > 0
    && (snapshot.repositoryGraphs?.length ?? 0) === 0;
  return {
    ...loaded,
    state: compilation.packet.requires_upstream || repositoryEvidenceMissing ? "degraded" : "succeeded",
    detail: repositoryEvidenceMissing ? "Weavatrix repository analysis pending or unavailable" : undefined,
    packet: packetStatus(compilation.packet),
  };
}

export async function cortexContextForView(
  view: ScopedMeshView,
  dependencies: Pick<CortexDependencies, "compile"> = {},
) {
  const config = loadRuntimeConfig().cortexByProject[view.project.projectId]
    ?? defaultCortexConfig();
  if (!config.enabled) return undefined;
  return (dependencies.compile ?? compileProjectContext)({
    projectId: view.project.projectId,
    taskId: view.task?.taskId ?? view.execution.taskId,
    maxTokens: config.maxTokens,
    evidence: cortexScopedEvidence(view),
  });
}

export function cortexSnapshotEvidence(
  snapshot: MeshSnapshot,
  taskId: string,
): EngineContextEvidence[] {
  const task = snapshot.tasks.find((value) => value.taskId === taskId);
  const evidence: EngineContextEvidence[] = [];
  if (task) evidence.push(item(
    "task.goal", "project.task", task.goal, "critical", "unverified", "plan",
    task.revision == null ? undefined : `task:${task.revision}`,
  ));
  if (snapshot.restrictions) evidence.push(item(
    "project.restrictions", "project.policy", JSON.stringify(snapshot.restrictions),
    "critical", "verified", "exact_source", `policy:${snapshot.restrictions.revision}`,
  ));
  if (snapshot.backbone) evidence.push(item(
    "project.backbone", "weavatrix.backbone", JSON.stringify(snapshot.backbone),
    "high", "verified", "graph", snapshot.backbone.head,
  ));
  for (const graph of snapshot.repositoryGraphs ?? []) evidence.push(item(
    `repository.${graph.repositoryId}`, "weavatrix.repository", JSON.stringify(graph),
    "high", "verified", "graph", graph.revision,
  ));
  for (const event of snapshot.events.filter((value) => value.taskId === taskId).slice(-32)) {
    evidence.push(item(
      `event.${event.eventId}`, "mesh.event", JSON.stringify(event),
      "normal", "unverified", "memory", `event:${event.createdAt}`,
    ));
  }
  return evidence;
}

export function cortexScopedEvidence(view: ScopedMeshView): EngineContextEvidence[] {
  const taskId = view.task?.taskId ?? view.execution.taskId;
  const evidence: EngineContextEvidence[] = [];
  if (view.task) evidence.push(item(
    "task.goal", "project.task", view.task.goal, "critical", "unverified", "plan",
    view.task.revision == null ? undefined : `task:${view.task.revision}`,
  ));
  if (view.restrictions) evidence.push(item(
    "project.restrictions", "project.policy", JSON.stringify(view.restrictions),
    "critical", "verified", "exact_source", `policy:${view.restrictions.revision}`,
  ));
  if (view.backbone) evidence.push(item(
    "project.backbone", "weavatrix.backbone", JSON.stringify(view.backbone),
    "high", "verified", "graph", view.backbone.head,
  ));
  for (const graph of view.repositoryGraphs ?? []) evidence.push(item(
    `repository.${graph.repositoryId}`, "weavatrix.repository", JSON.stringify(graph),
    "high", "verified", "graph", graph.revision,
  ));
  for (const event of view.events.slice(-32)) evidence.push(item(
    `event.${event.eventId}`, "mesh.event", JSON.stringify(event),
    "normal", "unverified", "memory", `event:${event.createdAt}`,
  ));
  if (view.skills?.length) evidence.push(item(
    "project.skills", "mesh.capabilities", JSON.stringify(view.skills),
    "normal", "verified", "exact_source", `mesh:${view.generatedAt}`,
  ));
  if (view.mcpServers?.length) evidence.push(item(
    "project.mcp", "mesh.capabilities", JSON.stringify(view.mcpServers),
    "normal", "verified", "exact_source", `mesh:${view.generatedAt}`,
  ));
  if (view.capabilityRequests?.length) evidence.push(item(
    "project.capability_requests", "mesh.capabilities",
    JSON.stringify(view.capabilityRequests), "normal", "verified", "exact_source",
    `mesh:${view.generatedAt}`,
  ));
  if (evidence.length === 0) evidence.push(item(
    "task.identity", "project.task", taskId, "critical", "unverified", "inferred",
  ));
  return evidence;
}

function item(
  id: string, source: string, content: string,
  priority: EngineContextEvidence["priority"], state: EngineContextEvidence["state"],
  derivation: EngineContextEvidence["derivation"] = "exact_source", snapshotId?: string,
): EngineContextEvidence {
  return { id, source, content, priority, state, derivation, snapshot_id: snapshotId };
}

function packetStatus(packet: EngineContextCompilation["packet"]) {
  return {
    packetId: packet.packet_id ?? undefined,
    snapshotId: packet.snapshot_id ?? undefined,
    included: packet.included_ids.length,
    omitted: packet.omitted_ids.length,
    rawEstimatedTokens: packet.raw_estimated_tokens,
    selectedEstimatedTokens: packet.selected_estimated_tokens,
    omittedEstimatedTokens: packet.omitted_estimated_tokens,
    deduplicatedLines: packet.deduplicated_lines,
    requiresUpstream: packet.requires_upstream,
  };
}
