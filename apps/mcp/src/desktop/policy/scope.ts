import { join } from "node:path";
import { configDir } from "../../../../bridge/src/config/runtime/paths";
import { computerId } from "../../../../bridge/src/mesh/identity/computer";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";

export type DesktopPolicyScopeOptions = { storePath?: string; endpointId?: string };

export function desktopPolicyScope(input: unknown, options: DesktopPolicyScopeOptions) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const query = input as Record<string, unknown>;
  const projectId = query.project_id;
  const endpointId = options.endpointId ?? computerId();
  if (typeof projectId !== "string" || !projectId || projectId.length > 128) return undefined;
  const loaded = readStoreState(options.storePath ?? join(configDir(), "project-mesh.json"));
  if (loaded.status !== "ok"
    || !loaded.state.projects.some((p) => p.projectId === projectId)
    || !loaded.state.bindings.some((b) => b.projectId === projectId
      && b.endpointId === endpointId && b.available)) return undefined;
  return { query, projectId, endpointId };
}
