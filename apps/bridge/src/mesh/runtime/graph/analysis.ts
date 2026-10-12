import type { RelayClient } from "../../../../../../packages/core/relay-client";
import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";
import { projectBackbone, projectRepositoryGraphs, waitForProjectBindingSync } from "../../../engine/runtime/engine-projects";
import { sendMeshPayload } from "../../../host/session-keys";
import { publishedCatalog } from "../../../session-catalog";
import { meshSnapshot, meshSnapshots } from "..";
import { refreshLocalGraphBindings } from "./binding-sync";

/** A person's explicit Graph refresh bypasses background job backoff. */
type GraphAnalysisDependencies = {
  snapshot?: (projectId: string) => MeshSnapshot | undefined;
  snapshots?: typeof meshSnapshots;
  wait: typeof waitForProjectBindingSync;
  sync?: typeof refreshLocalGraphBindings;
  backbone: typeof projectBackbone;
  graphs: typeof projectRepositoryGraphs;
  send: (client: RelayClient, snapshot: MeshSnapshot) => Promise<void>;
};

const graphAnalysisDependencies: GraphAnalysisDependencies = {
  snapshot: meshSnapshot,
  wait: waitForProjectBindingSync,
  sync: refreshLocalGraphBindings,
  backbone: projectBackbone,
  graphs: projectRepositoryGraphs,
  send: (client, snapshot) => sendMeshPayload(client, snapshot, "phone", {
    ttlMs: 60_000, reliable: true,
  }),
};

export async function analyzeProjectGraphNow(
  client: RelayClient, projectId: string,
  dependencies: GraphAnalysisDependencies = graphAnalysisDependencies,
  requestIds?: ReadonlySet<string>,
): Promise<boolean> {
  const known = publishedCatalog(client);
  const read = dependencies.snapshot ?? ((id: string) => dependencies.snapshots?.().find(item => item.projectId === id));
  const snapshot = dependencies === graphAnalysisDependencies
    ? meshSnapshot(projectId, known ? [...known.sessions, ...(known.history ?? [])] : undefined)
    : read(projectId);
  if (!snapshot) return false;
  await dependencies.wait(projectId);
  const current = dependencies === graphAnalysisDependencies
    ? meshSnapshot(projectId, known ? [...known.sessions, ...(known.history ?? [])] : undefined)
    : read(projectId);
  if (!current) return false;
  const failures = dependencies.sync ? await dependencies.sync(current) : [];
  const rejected = new Set(failures.map(report => report.repositoryId));
  const [backbone, repositoryGraphs] = await Promise.all([
    dependencies.backbone(projectId),
    dependencies.graphs(projectId, (current.bindings ?? []).filter(binding => !rejected.has(binding.repositoryId)), { background: false }),
  ]);
  const observed = [...repositoryGraphs, ...failures];
  const reports = observed.length > 0 ? observed : [{
    projectId, repositoryId: current.project.canonicalRepositoryId,
    revision: "unverified", weavatrixVersion: "unknown",
    analysisStatus: "UNAVAILABLE" as const, analysisErrorCode: "REPOSITORY_NOT_BOUND",
    nodes: [], relations: [], totalNodes: 0, totalRelations: 0, truncated: false,
  }];
  const receipts = requestIds?.size ? requestIds : new Set<string | undefined>([undefined]);
  for (const id of receipts) {
    await dependencies.send(client, {
      ...current, backbone, repositoryGraphs: reports, generatedAt: Date.now(),
      ...(id ? { graphAnalysisRequestId: id } : {}),
    });
  }
  return true;
}

