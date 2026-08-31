import { join } from "node:path";
import type {
  Project,
  ProjectBindingSummary,
} from "../../../../packages/protocol/schema";
import { configDir } from "../config/paths";
import { EngineClient } from "./engine-client";
import { engineFeatureEnabled, type EngineClientLike } from "./engine-supervisor";
import { sanitizedRepositoryRemote } from "../mesh/identity";

export type LocalProjectBinding = {
  summary: ProjectBindingSummary;
  localRoot?: string;
  canonicalRemote?: string;
  role?: "primary" | "dependency" | "supporting";
  lastSeenAt: number;
};

let sharedClient: EngineClient | undefined;

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

function defaultClient(): EngineClient {
  sharedClient ??= new EngineClient({ socketPath: join(configDir(), "engine.sock") });
  return sharedClient;
}
