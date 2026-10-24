import { projectRelationshipPeers, mergeRelationshipPeers } from "../../../engine/runtime/project-relationships";
import type { RelayClient } from "../../../../../../packages/core/relay-client";
import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";
import { projectBackbone, projectRepositoryGraphs, waitForProjectBindingSync } from "../../../engine/runtime/engine-projects";
import { sendMeshPayload } from "../../../host/session-keys";
import { publishedCatalog } from "../../../session-catalog";
import { meshSnapshot, meshSnapshots } from "..";
import { refreshLocalGraphBindings } from "./binding-sync";
import { graphAnalysisBindings } from "./checkout-identity";
import { computerId } from "../../identity/computer";
import { repositoryDetails } from "../../repository-details";

/** A person's explicit Graph refresh bypasses background job backoff. */
type GraphAnalysisDependencies = {
  snapshot?: (projectId: string) => MeshSnapshot | undefined;
  snapshots?: typeof meshSnapshots;
  wait: typeof waitForProjectBindingSync;
  sync?: typeof refreshLocalGraphBindings;
  backbone: typeof projectBackbone;
  graphs: typeof projectRepositoryGraphs;
  relationships?: typeof projectRelationshipPeers;
  send: (client: RelayClient, snapshot: MeshSnapshot) => Promise<void>;
  endpoint?: () => string;
  details?: (snapshot: MeshSnapshot) => ReturnType<typeof repositoryDetails>;
};

const graphAnalysisDependencies: GraphAnalysisDependencies = {
  snapshot: meshSnapshot,
  wait: waitForProjectBindingSync,
  sync: refreshLocalGraphBindings,
  backbone: projectBackbone,
  graphs: projectRepositoryGraphs,
  relationships: projectRelationshipPeers,
  endpoint: computerId,
  details: snapshot => repositoryDetails(snapshot, computerId()),
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
  const bindings = graphAnalysisBindings((current.bindings ?? [])
    .filter(binding => !rejected.has(binding.repositoryId)), dependencies.endpoint?.());
  if (dependencies.endpoint && !bindings.length && !failures.length && current.bindings?.length) return false;
  const [backbone, repositoryGraphs, details] = await Promise.all([
    dependencies.backbone(projectId),
    dependencies.graphs(projectId, bindings, { background: false }),
    dependencies.details?.(current),
  ]);
  const relationships = await dependencies.relationships?.(projectId, bindings, { background: false });
  const peers = relationships === undefined ? current.peers
    : mergeRelationshipPeers(current.peers, relationships);
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
      ...current, backbone, peers, repositoryGraphs: reports, generatedAt: Date.now(),
      ...(details ? { repositoryDetails: details } : {}),
      ...(id ? { graphAnalysisRequestId: id } : {}),
    });
  }
  return true;
}

