import { join } from "node:path";
import type {
  Project,
  ProjectBindingSummary,
} from "../../../../../packages/protocol/schema";
import { configDir } from "../../config/runtime/paths";
import { EngineClient } from "./engine-client";
import { EngineProtocolError } from "../protocol/transport/protocol-base";
import { engineFeatureEnabled, type EngineClientLike } from "./engine-supervisor";
import { sanitizedRepositoryRemote } from "../../mesh/identity";
import type { ProjectBackbone } from "../../../../../packages/protocol/schema";
import type { ProjectRepositoryGraph } from "../../../../../packages/protocol/schema";
import type {
  EngineContextCompilation,
  EngineContextEvidence,
} from "../protocol/engine-protocol";
import { fitRepositoryGraph } from "./repository-graph/fit";
import {
  BACKGROUND_ANALYSIS_MS, EXPLICIT_ANALYSIS_MS, analyzeRepositoryGraph, repositoryGraphJobs, repositoryGraphKey,
  repositoryObservation,
} from "./repository-graph/analysis";

export type LocalProjectBinding = {
  summary: ProjectBindingSummary;
  localRoot?: string;
  canonicalRemote?: string;
  role?: "primary" | "dependency" | "supporting";
  lastSeenAt: number;
};

let sharedClient: EngineClient | undefined;
const pendingBindingSyncs = new Map<string, Promise<boolean>>();
// The Apple Mesh envelope is 256KiB; leave room for Tasks, bindings and receipts.
const MAX_REPOSITORY_GRAPH_WIRE_BYTES = 192 * 1_024 - 128;
const MAX_SINGLE_GRAPH_WIRE_BYTES = 192 * 1_024;

export async function syncProjectBinding(
  project: Project,
  local: LocalProjectBinding,
  options: { env?: NodeJS.ProcessEnv; client?: EngineClientLike } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!engineFeatureEnabled(env)) return false;
  // Repository admission is restore work; keep it off the policy connection.
  const client = options.client ?? new EngineClient({
    socketPath: join(configDir(), "engine.sock"), connectTimeoutMs: 10_000,
  });
  try {
    const result = await client.request({
      operation: "project.upsert_binding",
      input: {
        project: {
          project_id: project.projectId,
          name: project.name,
          created_at: engineTimestamp(project.createdAt),
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
          last_seen_at: engineTimestamp(local.lastSeenAt),
        },
      },
    }, { timeoutMs: 30_000 });
    return result.operation === "project.binding_upserted";
  } catch {
    return false;
  } finally {
    if (!options.client) client.close?.();
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
  const client = options.client;
  const repositories = [...new Map(bindings.map((item) => [item.repositoryId, item])).values()].slice(0, 64);
  const observations = await Promise.all(repositories.map(binding =>
    repositoryObservation(binding, !options.background)));
  const graphs = options.background
    ? repositories.map((binding, index) => repositoryGraphJobs.read(repositoryGraphKey(projectId, binding),
      () => analyzeRepositoryGraph(client, projectId, binding.repositoryId, BACKGROUND_ANALYSIS_MS, binding.revision),
      options.priority ?? 0, false, observations[index],
    ))
    : await Promise.all(repositories.map((binding, index) => repositoryGraphJobs.refresh(
      repositoryGraphKey(projectId, binding),
      () => analyzeRepositoryGraph(client, projectId, binding.repositoryId, EXPLICIT_ANALYSIS_MS, binding.revision),
      Number.MAX_SAFE_INTEGER, observations[index],
    )));
  return boundRepositoryGraphs(graphs.filter((item): item is ProjectRepositoryGraph => item != null));
}

function boundRepositoryGraphs(graphs: ProjectRepositoryGraph[]): ProjectRepositoryGraph[] {
  const result: ProjectRepositoryGraph[] = [];
  let remaining = MAX_REPOSITORY_GRAPH_WIRE_BYTES;
  for (const [index, graph] of graphs.entries()) {
    if (remaining < 1_024) break;
    const fairShare = Math.floor(remaining / (graphs.length - index));
    const bounded = fitRepositoryGraph(graph, Math.min(fairShare, MAX_SINGLE_GRAPH_WIRE_BYTES));
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

/** Provider file times carry sub-millisecond precision; Engine epochs are u64 milliseconds. */
function engineTimestamp(value: number): number {
  const milliseconds = Math.floor(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new EngineProtocolError("Engine timestamp must be nonnegative safe milliseconds");
  }
  return milliseconds;
}
