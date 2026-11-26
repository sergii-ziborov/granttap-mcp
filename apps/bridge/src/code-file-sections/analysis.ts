import type { MeshSnapshot, ProjectBindingSummary, ProjectRepositoryGraph } from "../../../../packages/protocol/schema";
import { engineFeatureEnabled } from "../engine/runtime/engine-supervisor";
import { queueProjectBindingSync } from "../engine/runtime/engine-projects";
import { refreshRepositoryGraph } from "../engine/runtime/repository-graph/analysis";
import { readEngineCodeFile, type CodeFileReadOptions } from "../engine/runtime/repository-graph/code-file";
import { refreshLocalGraphBindings } from "../mesh/runtime/graph/binding-sync";
import { graphAnalysisBindings, prepareGraphInspection } from "../mesh/runtime/graph/checkout-identity";
import { computerId } from "../mesh/identity/computer";
import { localMeshStore } from "../mesh/local-remote/local";
import type { AnalysisOutcome, CodeFileSectionsDependencies } from ".";

export type CodeFileAnalysisDependencies = {
  snapshot: (projectId: string) => MeshSnapshot | undefined;
  endpoint: () => string;
  engineEnabled: () => boolean;
  prepare: typeof prepareGraphInspection;
  admit: typeof refreshLocalGraphBindings;
  refresh: (projectId: string, binding: ProjectBindingSummary) => Promise<ProjectRepositoryGraph | undefined>;
};

const UNBOUND = new Set(["REPOSITORY_NOT_BOUND", "REPOSITORY_NOT_LOCAL", "REPOSITORY_IDENTITY_MISMATCH",
  "REPOSITORY_IDENTITY_UNVERIFIED"]);

/** A checkout of the repository on this computer, in the Project, by its binding alone. */
export function boundHere(snapshot: MeshSnapshot | undefined, endpoint: string, repositoryId: string): boolean {
  return (snapshot?.bindings ?? []).some(binding => binding.endpointId === endpoint
    && binding.repositoryId === repositoryId && binding.available && binding.localPathHint);
}

/**
 * Fills the Engine's memory of one repository the way a person's Graph build does: re-admit this
 * computer's checkouts, select the one graph publication analyses for the repository, and join or
 * start that repository's `graph.analyze_repository` job with the explicit build's time limit.
 */
export async function analyzeCodeFileRepository(
  projectId: string, repositoryId: string, deps: CodeFileAnalysisDependencies,
): Promise<AnalysisOutcome> {
  if (!deps.engineEnabled()) return "engine_unavailable";
  const snapshot = deps.snapshot(projectId);
  const endpoint = deps.endpoint();
  if (!snapshot || !boundHere(snapshot, endpoint, repositoryId)) return "not_bound";
  const inspect = await deps.prepare(snapshot.bindings ?? [], endpoint);
  // An Engine restarted since the last publication learns the checkout again before it is analysed.
  const failures = await deps.admit(snapshot, { endpoint: () => endpoint, inspect, sync: queueProjectBindingSync });
  const failure = failures.find(report => report.repositoryId === repositoryId);
  if (failure) return failure.analysisErrorCode === "ENGINE_ADMISSION_UNAVAILABLE" ? "engine_unavailable" : "not_bound";
  const rejected = new Set(failures.map(report => report.repositoryId));
  const binding = graphAnalysisBindings((snapshot.bindings ?? []).filter(item => !rejected.has(item.repositoryId)),
    endpoint, inspect).find(item => item.repositoryId === repositoryId);
  if (!binding) return "not_bound";
  return analysisOutcome(await deps.refresh(projectId, binding));
}

export function analysisOutcome(graph: ProjectRepositoryGraph | undefined): AnalysisOutcome {
  if (!graph) return "analysis_failed";
  if (graph.analysisStatus !== "UNAVAILABLE") return "ok";
  if (graph.analysisErrorCode === "ENGINE_UNAVAILABLE") return "engine_unavailable";
  return UNBOUND.has(graph.analysisErrorCode ?? "") ? "not_bound" : "analysis_failed";
}

/** The computer's own Mesh state, Engine and analysis queue; `read` options pick the Engine channel. */
export function defaultCodeFileDependencies(options: {
  snapshot?: (projectId: string) => MeshSnapshot | undefined; read?: CodeFileReadOptions; available?: () => boolean;
} = {}): CodeFileSectionsDependencies {
  const snapshot = options.snapshot ?? ((projectId: string) => localMeshStore().snapshot(projectId, computerId()));
  const analysis: CodeFileAnalysisDependencies = {
    snapshot, endpoint: computerId, engineEnabled: () => engineFeatureEnabled(),
    prepare: prepareGraphInspection, admit: refreshLocalGraphBindings,
    refresh: (projectId, binding) => refreshRepositoryGraph(projectId, binding),
  };
  return {
    bound: (projectId, repositoryId) => (options.available?.() ?? true)
      && boundHere(snapshot(projectId), computerId(), repositoryId),
    read: key => readEngineCodeFile(key, options.read),
    analyze: (projectId, repositoryId) => analyzeCodeFileRepository(projectId, repositoryId, analysis),
    now: Date.now,
  };
}
