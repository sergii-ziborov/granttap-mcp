import { join } from "node:path";
import type { ProjectBindingSummary, ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";
import { configDir } from "../../../config/runtime/paths";
import { EngineClient } from "../engine-client";
import type { EngineClientLike } from "../engine-supervisor";
import { EngineRemoteError } from "../../protocol/transport/protocol-base";
import { RepositoryGraphJobs } from "../repository-graph-jobs";
import { RepositoryGraphCache } from "./cache";
import { repositorySourceMap } from "./source-map";
import { repositorySourceFingerprint } from "./source-state";

/** A person asked for this build; a repository the size of pytorch did not finish in two minutes. */
export const EXPLICIT_ANALYSIS_MS = 600_000;
export const BACKGROUND_ANALYSIS_MS = 120_000;

/**
 * One queue for every `graph.analyze_repository` this process starts: Mesh publication, a person's
 * Graph build and a code file's sections all join the same repository revision's job.
 */
export const repositoryGraphJobs = new RepositoryGraphJobs<ProjectRepositoryGraph>(Date.now, 120_000, 300_000, 32,
  new RepositoryGraphCache(() => join(configDir(), "repository-graph-cache")));

export type RepositoryObservation = {
  fingerprint: string; reusable: (graph: ProjectRepositoryGraph) => boolean;
} | undefined;

export function repositoryGraphKey(projectId: string, binding: ProjectBindingSummary): string {
  return JSON.stringify([projectId, binding.repositoryId, binding.revision]);
}

/** The Git-visible source state that lets an unchanged repository reuse its report. */
export async function repositoryObservation(binding: ProjectBindingSummary, fresh: boolean): Promise<RepositoryObservation> {
  const fingerprint = binding.localPathHint
    ? await repositorySourceFingerprint(binding.localPathHint, binding.revision, { fresh })
    : undefined;
  return fingerprint ? { fingerprint, reusable: (graph: ProjectRepositoryGraph) =>
    ['COMPLETE', 'INCOMPLETE'].includes(graph.analysisStatus ?? '') } : undefined;
}

/**
 * Analyse one repository now, as a person's build does: it joins a queued or running job for the same
 * revision, goes to the front of the queue and has the explicit build's ten minutes.
 */
export async function refreshRepositoryGraph(projectId: string, binding: ProjectBindingSummary,
  options: { client?: EngineClientLike } = {}): Promise<ProjectRepositoryGraph | undefined> {
  const observation = await repositoryObservation(binding, true);
  return repositoryGraphJobs.refresh(repositoryGraphKey(projectId, binding),
    () => analyzeRepositoryGraph(options.client, projectId, binding.repositoryId, EXPLICIT_ANALYSIS_MS, binding.revision),
    Number.MAX_SAFE_INTEGER, observation);
}

export async function analyzeRepositoryGraph(
  client: EngineClientLike | undefined, projectId: string, repositoryId: string, timeoutMs: number,
  sourceRevision?: string,
): Promise<ProjectRepositoryGraph | undefined> {
  // The daemon serves a socket serially. Analysis must not occupy the channel
  // used for policy, bindings and Backbone reads while a repository is scanned.
  const channel = client ?? new EngineClient({
    socketPath: join(configDir(), "engine.sock"), connectTimeoutMs: 10_000,
  });
  try {
    const result = await channel.request({
      operation: "graph.analyze_repository", input: {
        project_id: projectId, repository_id: repositoryId,
      },
    }, { timeoutMs });
    if (result.operation !== "graph.repository") return undefined;
    const graph = result.graph;
    return {
      projectId: graph.project_id, repositoryId: graph.repository_id,
      revision: graph.revision, weavatrixVersion: graph.weavatrix_version,
      sourceRevision,
      analysisId: graph.analysis_id ?? undefined,
      analysisStatus: graph.analysis_status,
      architectureHypotheses: graph.architecture_hypotheses,
      codeMap: repositorySourceMap(graph),
      nodes: graph.nodes,
      relations: graph.relations.map((edge) => ({
        source: edge.source, target: edge.target, relation: edge.relation,
        evidenceCount: edge.evidence_count,
      })),
      totalNodes: graph.total_nodes, totalRelations: graph.total_relations,
      truncated: graph.truncated,
    };
  } catch (error) {
    const known = new Set([
      "REPOSITORY_IDENTITY_MISMATCH", "REPOSITORY_IDENTITY_UNVERIFIED",
      "REPOSITORY_NOT_BOUND", "REPOSITORY_NOT_LOCAL", "WEAVATRIX_REPOSITORY_REQUIRED",
      "WEAVATRIX_ANALYSIS_FAILED", "WEAVATRIX_ANALYSIS_PANICKED",
      "WEAVATRIX_ARCHITECTURE_FAILED", "WEAVATRIX_REPORT_INVALID",
    ]);
    const code = error instanceof EngineRemoteError && known.has(error.code)
      ? error.code : "ENGINE_UNAVAILABLE";
    return {
      projectId, repositoryId, revision: "unverified", weavatrixVersion: "unknown",
      analysisStatus: "UNAVAILABLE", analysisErrorCode: code,
      nodes: [], relations: [], totalNodes: 0, totalRelations: 0, truncated: false,
    };
  } finally {
    if (!client) channel.close();
  }
}
