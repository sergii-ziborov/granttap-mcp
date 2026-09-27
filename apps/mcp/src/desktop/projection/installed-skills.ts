import { join } from "node:path";
import { configDir } from "../../../../bridge/src/config/runtime/paths";
import { computerId } from "../../../../bridge/src/mesh/identity/computer";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";
import { workspaceSkills } from "../../../../bridge/src/capabilities/skills";

/** A local inventory for the selected Mesh's bound workspaces, not Mesh policy. */
export function desktopInstalledSkills(
  input: unknown,
  storePath = join(configDir(), "project-mesh.json"),
  endpointId = computerId(),
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const projectId = (input as { project_id?: unknown }).project_id;
  if (typeof projectId !== "string" || !projectId || projectId.length > 128) return undefined;
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok"
    || !loaded.state.projects.some((project) => project.projectId === projectId)) {
    return undefined;
  }
  const names = new Map<string, { name: string; description?: string }>();
  for (const binding of loaded.state.bindings) {
    if (binding.projectId !== projectId || binding.endpointId !== endpointId
      || !binding.available || !binding.localPathHint) continue;
    for (const skill of workspaceSkills(binding.localPathHint)) {
      if (skill.name.length > 128 || names.has(skill.name)) continue;
      names.set(skill.name, {
        name: skill.name, description: skill.description?.slice(0, 500),
      });
    }
  }
  return {
    operation: "desktop.installed_skills" as const,
    project_id: projectId,
    endpoint_id: endpointId,
    skills: [...names.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 64),
  };
}
