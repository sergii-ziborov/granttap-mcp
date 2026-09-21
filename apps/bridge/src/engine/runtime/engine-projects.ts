import { join } from "node:path";
import type {
  Project,
  ProjectBindingSummary,
} from "../../../../../packages/protocol/schema";
import { configDir } from "../../config/runtime/paths";
import { EngineClient } from "./engine-client";
import { engineFeatureEnabled, type EngineClientLike } from "./engine-supervisor";
import { sanitizedRepositoryRemote } from "../../mesh/identity";
import type { ProjectBackbone } from "../../../../../packages/protocol/schema";
import type { ProjectRepositoryGraph } from "../../../../../packages/protocol/schema";
import type {
  EngineContextCompilation,
  EngineContextEvidence,
} from "../protocol/engine-protocol";

export type LocalProjectBinding = {
  summary: ProjectBindingSummary;
  localRoot?: string;
  canonicalRemote?: string;
  role?: "primary" | "dependency" | "supporting";
  lastSeenAt: number;
};

let sharedClient: EngineClient | undefined;
const MAX_REPOSITORY_GRAPH_WIRE_BYTES = 128 * 1_024;
const MAX_SINGLE_GRAPH_WIRE_BYTES = 48 * 1_024;

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
    }, { timeoutMs: 250 });
    return result.operation === "project.binding_upserted";
  } catch {
    return false;
  }
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
      },
    }, { timeoutMs: 5_000 });
    return result.operation === "context.compiled" ? result.compilation : undefined;
  } catch { return undefined; }
}

export async function projectRepositoryGraphs(
  projectId: string,
  bindings: ProjectBindingSummary[],
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike } = {},
): Promise<ProjectRepositoryGraph[]> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return [];
  const client = options.client ?? defaultClient();
  const repositories = [...new Map(bindings.map((item) => [item.repositoryId, item])).values()].slice(0, 64);
  const graphs = await Promise.all(repositories.map(async (binding) => {
    const repositoryId = binding.repositoryId;
    try {
      const result = await client.request({
        operation: "graph.analyze_repository", input: {
          project_id: projectId, repository_id: repositoryId,
        },
      }, { timeoutMs: 30_000 });
      if (result.operation !== "graph.repository") return undefined;
      const graph = result.graph;
      const mapped: ProjectRepositoryGraph = {
        projectId: graph.project_id, repositoryId: graph.repository_id,
        revision: graph.revision, weavatrixVersion: graph.weavatrix_version,
        analysisId: graph.analysis_id ?? undefined,
        analysisStatus: graph.analysis_status,
        nodes: graph.nodes,
        relations: graph.relations.map((edge) => ({
          source: edge.source, target: edge.target, relation: edge.relation,
          evidenceCount: edge.evidence_count,
        })),
        totalNodes: graph.total_nodes, totalRelations: graph.total_relations,
        truncated: graph.truncated,
      };
      return mapped;
    } catch { return undefined; }
  }));
  return boundRepositoryGraphs(graphs.filter((item): item is ProjectRepositoryGraph => item != null));
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

function fitRepositoryGraph(
  graph: ProjectRepositoryGraph,
  maxBytes: number,
): ProjectRepositoryGraph | undefined {
  let nodes = graph.nodes;
  let relations = graph.relations;
  let bounded = graph;
  while (Buffer.byteLength(JSON.stringify(bounded), "utf8") > maxBytes
    && (nodes.length > 8 || relations.length > 8)) {
    if (relations.length >= nodes.length && relations.length > 8) {
      relations = relations.slice(0, Math.max(8, Math.floor(relations.length / 2)));
    } else if (nodes.length > 8) {
      nodes = nodes.slice(0, Math.max(8, Math.floor(nodes.length / 2)));
      const ids = new Set(nodes.map((node) => node.id));
      relations = relations.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    }
    bounded = { ...graph, nodes, relations, truncated: true };
  }
  return Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes ? bounded : undefined;
}

function defaultClient(): EngineClient {
  sharedClient ??= new EngineClient({ socketPath: join(configDir(), "engine.sock") });
  return sharedClient;
}
