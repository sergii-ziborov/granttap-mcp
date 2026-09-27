import type { EngineClientLike } from "../../engine/runtime/engine-supervisor";

export type ImpactScope = {
  projectId: string;
  taskId: string;
  repositoryId: string;
  repositoryRevision: string;
  path: string;
};

/** Bounded Engine graph queries; no repository scan runs on the hook path. */
export async function verifiedImpactAvailable(
  client: EngineClientLike,
  scope: ImpactScope,
  deadline: number,
  now: () => number,
): Promise<boolean> {
  try {
    const firstBudget = deadline - now();
    if (firstBudget <= 0) return false;
    const headsResult = await client.request({
      operation: "graph.get_heads",
      input: { project_id: scope.projectId, task_id: scope.taskId },
    }, { timeoutMs: firstBudget });
    if (headsResult.operation !== "graph.heads"
      || headsResult.heads.project_id !== scope.projectId) return false;
    const head = headsResult.heads.task_graph_heads.find((row) => row.task_id === scope.taskId)?.head;
    const revision = headsResult.heads.repo_revisions
      .find((row) => row.repository_id === scope.repositoryId)?.revision;
    if (!head || revision !== scope.repositoryRevision) return false;
    const secondBudget = deadline - now();
    if (secondBudget <= 0) return false;
    const impactResult = await client.request({
      operation: "graph.compute_impact",
      input: {
        project_id: scope.projectId, task_id: scope.taskId,
        repository_id: scope.repositoryId, paths: [scope.path], max_results: 256,
      },
    }, { timeoutMs: secondBudget });
    if (impactResult.operation !== "graph.impact") return false;
    const impact = impactResult.impact;
    return impact.task_graph_head === head
      && impact.completeness === "complete"
      && impact.unresolved.length === 0
      && impact.repositories.includes(scope.repositoryId)
      && impact.files.includes(scope.path)
      && impact.affected_roots.includes(`file:${scope.repositoryId}:${scope.path}`);
  } catch {
    return false;
  }
}
