import { join } from "node:path";
import { configDir } from "../../../bridge/src/config/runtime/paths";
import { readStoreState } from "../../../bridge/src/mesh/store/state";

/** Read the MCP-owned Mesh registry when an older Engine lacks project.list. */
export function desktopProjectCatalog(input: unknown, storePath = join(configDir(), "project-mesh.json")) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  const after = fields.after_project_id;
  const limit = fields.limit;
  if ((after !== undefined && (typeof after !== "string" || after.length > 128))
    || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50) return undefined;
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok" && loaded.status !== "missing") return undefined;
  const projects = loaded.state.projects
    .filter((item) => item.projectId > (after ?? ""))
    .sort((left, right) => left.projectId < right.projectId ? -1
      : left.projectId > right.projectId ? 1 : 0);
  const page = projects.slice(0, Number(limit));
  return {
    operation: "project.listed" as const,
    page: {
      projects: page.map((item) => ({
        project_id: item.projectId, name: item.name, created_at: item.createdAt,
      })),
      next_after_project_id: projects.length > page.length
        ? page.at(-1)?.projectId ?? null : null,
    },
  };
}
