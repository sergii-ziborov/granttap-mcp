import { join } from "node:path";
import type { IntegrationPeer, ProjectBindingSummary } from "../../../../../../packages/protocol/schema";
import type { EngineProjectRelationships } from "../../protocol/project-relationships";
import { configDir } from "../../../config/runtime/paths";
import { EngineClient } from "../engine-client";
import { engineFeatureEnabled, type EngineClientLike } from "../engine-supervisor";
import { RepositoryGraphJobs } from "../repository-graph-jobs";

type Analysis = { graph: EngineProjectRelationships; observedAt: number };
const jobs = new RepositoryGraphJobs<Analysis>(Date.now, 120_000, 300_000, 8);
const STATIC_CONTRACT_PREFIX = "Weavatrix: static ";

/** Static compatibility is shown as shared contracts, never a proven dependency. */
export async function projectRelationshipPeers(
  projectId: string,
  bindings: ProjectBindingSummary[],
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike; background?: boolean } = {},
): Promise<IntegrationPeer[]> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return [];
  const ids = [...new Set(bindings.map(binding => binding.repositoryId))].sort();
  if (ids.length < 2 || ids.length > 8) return [];
  const key = JSON.stringify([
    projectId, ids, bindings.map(item => [item.bindingId, item.revision]).sort(),
  ]);
  // Background snapshots read retained results; explicit Graph builds start analysis.
  const result = options.background
    ? jobs.cached(key)
    : await jobs.refresh(key, () => analyze(projectId, ids, options.client));
  if (!result) return [];
  return result.graph.matches.flatMap(edge => {
    if (edge.target.length > 160) return [];
    return [{
      projectId,
      repositoryId: edge.source,
      peer: edge.target,
      via: edge.transport === "event" ? "kafka" as const : "api" as const,
      relation: "shares" as const,
      through: `${STATIC_CONTRACT_PREFIX}${edge.transport.toUpperCase()} contract; runtime target unverified`,
      updatedAt: result.observedAt,
    }];
  }).slice(0, 64);
}

async function analyze(
  projectId: string, ids: string[], supplied?: EngineClientLike,
): Promise<Analysis | undefined> {
  const client = supplied ?? new EngineClient({
    socketPath: join(configDir(), "engine.sock"), connectTimeoutMs: 10_000,
  });
  try {
    const result = await client.request({
      operation: "graph.analyze_project",
      input: { project_id: projectId, repository_ids: ids },
    }, { timeoutMs: 120_000 });
    if (result.operation !== "graph.project_relationships" || result.graph.project_id !== projectId
      || JSON.stringify(result.graph.repositories.map(item => item.repository_id).sort()) !== JSON.stringify(ids)) {
      return undefined;
    }
    return { graph: result.graph, observedAt: Date.now() };
  } catch { return undefined; }
  finally { if (!supplied) client.close(); }
}

export function mergeRelationshipPeers(
  current: IntegrationPeer[] | undefined, analyzed: IntegrationPeer[],
): IntegrationPeer[] {
  return [
    ...(current ?? []).filter(peer => !peer.through?.startsWith(STATIC_CONTRACT_PREFIX)),
    ...analyzed,
  ].slice(0, 64);
}
