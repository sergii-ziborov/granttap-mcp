import { join } from "node:path";
import type {
  Project,
  ProjectBindingSummary,
} from "../../../../../packages/protocol/schema";
import { configDir } from "../../config/runtime/paths";
import { EngineClient } from "./engine-client";
import { EngineRemoteError } from "../protocol/transport/protocol-base";
import { engineFeatureEnabled, type EngineClientLike } from "./engine-supervisor";
import { sanitizedRepositoryRemote } from "../../mesh/identity";
import type { ProjectBackbone } from "../../../../../packages/protocol/schema";
import type { ProjectRepositoryGraph } from "../../../../../packages/protocol/schema";
import type {
  EngineContextCompilation,
  EngineContextEvidence,
} from "../protocol/engine-protocol";
import { RepositoryGraphJobs } from "./repository-graph-jobs";
import { fitRepositoryGraph } from "./repository-graph/fit";

export type LocalProjectBinding = {
  summary: ProjectBindingSummary;
  localRoot?: string;
  canonicalRemote?: string;
  role?: "primary" | "dependency" | "supporting";
  lastSeenAt: number;
};

let sharedClient: EngineClient | undefined;
const pendingBindingSyncs = new Map<string, Promise<boolean>>();
const MAX_REPOSITORY_GRAPH_WIRE_BYTES = 128 * 1_024;
const MAX_SINGLE_GRAPH_WIRE_BYTES = 96 * 1_024;
const repositoryGraphJobs = new RepositoryGraphJobs<ProjectRepositoryGraph>();

export async function syncProjectBinding(
  project: Project,
  local: LocalProjectBinding,
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!engineFeatureEnabled(env)) return false;
  const client = options.client ?? defaultClient();
  try {
    const result = await client.request({
      operation: "project.upsert_binding",
      input: {
        project: {
          project_id: project.projectId,
          name: project.name,
          created_at: project.createdAt,
        },
        binding: {
          binding_id: local.summary.bindingId,
          project_id: local.summary.projectId,
          endpoint_id: local.summary.endpointId,
          repository_id: local.summary.repositoryId,
          local_root: local.localRoot,
          local_alias: local.summary.displayName,
          canonical_remote: local.canonicalRemote
            ? sanitizedRepositoryRemote(local.canonicalRemote)
            : undefined,
          role: local.role ?? "primary",
          observed_revision: local.summary.revision,
          last_seen_at: local.lastSeenAt,
        },
      },
    }, { timeoutMs: 5_000 });
    return result.operation === "project.binding_upserted";
  } catch {
    return false;
  }
}

/** Keep the current repository admission visible until graph enrichment begins. */
export function queueProjectBindingSync(
  project: Project,
  local: LocalProjectBinding,
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike } = {},
): Promise<boolean> {
  const key = JSON.stringify([project.projectId, local.summary.bindingId]);
  const pending = pendingBindingSyncs.get(key);
  if (pending) return pending;
  const request = syncProjectBinding(project, local, options);
  pendingBindingSyncs.set(key, request);
  void request.finally(() => {
    if (pendingBindingSyncs.get(key) === request) pendingBindingSyncs.delete(key);
  });
  return request;
}

export async function waitForProjectBindingSync(projectId: string): Promise<void> {
  const requests = [...pendingBindingSyncs].filter(([key]) =>
    JSON.parse(key)[0] === projectId
  ).map(([, request]) => request);
  await Promise.all(requests.map((request) => request.catch(() => false)));
}

export function closeProjectEngineClient(): void {
  sharedClient?.close();
  sharedClient = undefined;
}

export async function projectBackbone(
  projectId: string,
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike } = {},
): Promise<ProjectBackbone | undefined> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return undefined;
  try {
    const result = await (options.client ?? defaultClient()).request({
      operation: "graph.get_backbone", input: { project_id: projectId },
    }, { timeoutMs: 250 });
    if (result.operation !== "graph.backbone") return undefined;
    return {
      projectId: result.backbone.project_id,
      head: result.backbone.head ?? undefined,
      nodes: result.backbone.nodes.map((node) => ({
        kind: node.kind, identity: node.identity, displayName: node.display_name,
      })),
      relations: result.backbone.relations.map((relation) => ({
        source: relation.source, target: relation.target, relation: relation.relation,
        evidenceCount: relation.evidence_count,
      })),
      pendingCandidateCount: result.backbone.pending_candidate_count,
    };
  } catch { return undefined; }
}

export type ProjectEngineProvenance = {
  engineVersion: string;
  cortexVersion: string;
  cortexRevision: string;
  weavatrixVersion: string;
};

export async function projectEngineProvenance(
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike } = {},
): Promise<ProjectEngineProvenance | undefined> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return undefined;
  try {
    const result = await (options.client ?? defaultClient()).request(
      { operation: "engine.version" }, { timeoutMs: 500 },
    );
    if (result.operation !== "engine.version") return undefined;
    return {
      engineVersion: result.engine_version,
      cortexVersion: result.cortex_version,
      cortexRevision: result.cortex_revision,
      weavatrixVersion: result.weavatrix_version,
    };
  } catch { return undefined; }
}

export async function compileProjectContext(
  input: {
    projectId: string;
    taskId: string;
    maxTokens: number;
    evidence: EngineContextEvidence[];
    targetRepositoryId?: string;
  },
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike } = {},
): Promise<EngineContextCompilation | undefined> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return undefined;
  try {
    const result = await (options.client ?? defaultClient()).request({
      operation: "context.compile_project",
      input: {
        project_id: input.projectId,
        task_id: input.taskId,
        max_tokens: input.maxTokens,
        evidence: input.evidence,
        target_repository_id: input.targetRepositoryId,
      },
    }, { timeoutMs: input.targetRepositoryId ? 30_000 : 5_000 });
    return result.operation === "context.compiled" ? result.compilation : undefined;
  } catch { return undefined; }
}

export async function projectRepositoryGraphs(
  projectId: string,
  bindings: ProjectBindingSummary[],
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike; background?: boolean;
    priority?: number } = {},
): Promise<ProjectRepositoryGraph[]> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return [];
  const client = options.client ?? defaultClient();
  const repositories = [...new Map(bindings.map((item) => [item.repositoryId, item])).values()].slice(0, 64);
  const graphs = options.background
    ? repositories.map((binding) => repositoryGraphJobs.read(
      JSON.stringify([projectId, binding.repositoryId, binding.revision]),
      () => analyzeRepositoryGraph(client, projectId, binding.repositoryId, 120_000),
      options.priority ?? 0,
    ))
    : await Promise.all(repositories.map((binding) =>
      analyzeRepositoryGraph(client, projectId, binding.repositoryId, 30_000)));
  return boundRepositoryGraphs(graphs.filter((item): item is ProjectRepositoryGraph => item != null));
}

async function analyzeRepositoryGraph(
  client: EngineClientLike, projectId: string, repositoryId: string, timeoutMs: number,
): Promise<ProjectRepositoryGraph | undefined> {
  try {
    const result = await client.request({
      operation: "graph.analyze_repository", input: {
        project_id: projectId, repository_id: repositoryId,
      },
    }, { timeoutMs });
    if (result.operation !== "graph.repository") return undefined;
    const graph = result.graph;
    return {
      projectId: graph.project_id, repositoryId: graph.repository_id,
      revision: graph.revision, weavatrixVersion: graph.weavatrix_version,
      analysisId: graph.analysis_id ?? undefined,
      analysisStatus: graph.analysis_status,
      architectureHypotheses: graph.architecture_hypotheses,
      codeMap: graph.code_map ? {
        files: graph.code_map.files.map((file) => ({
          path: file.path, language: file.language, lineCount: file.line_count,
          symbols: file.symbols.map((symbol) => ({
            id: symbol.id, label: symbol.label, kind: symbol.kind,
            startLine: symbol.start_line, lineCount: symbol.line_count,
          })),
        })),
        externals: graph.code_map.externals ?? [],
        roads: graph.code_map.roads,
        totalFiles: graph.code_map.total_files,
        totalExternals: graph.code_map.total_externals ?? 0,
        truncated: graph.code_map.truncated,
      } : undefined,
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
  }
}

function boundRepositoryGraphs(graphs: ProjectRepositoryGraph[]): ProjectRepositoryGraph[] {
  const result: ProjectRepositoryGraph[] = [];
  let remaining = MAX_REPOSITORY_GRAPH_WIRE_BYTES;
  for (const graph of graphs) {
    if (remaining < 1_024) break;
    const bounded = fitRepositoryGraph(graph, Math.min(remaining, MAX_SINGLE_GRAPH_WIRE_BYTES));
    if (!bounded) continue;
    result.push(bounded);
    remaining -= Buffer.byteLength(JSON.stringify(bounded), "utf8");
  }
  return result;
}

function defaultClient(): EngineClient {
  sharedClient ??= new EngineClient({ socketPath: join(configDir(), "engine.sock") });
  return sharedClient;
}
