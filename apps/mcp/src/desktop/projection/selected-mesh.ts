import { configuredProjectMcpServers } from "../../../../bridge/src/mesh/catalog/project/configured-mcp";
import { projectSharedSkills } from "../../../../bridge/src/capabilities/skills";
import { computerId } from "../../../../bridge/src/mesh/identity/computer";
import { enrichMeshSnapshot } from "../../../../bridge/src/mesh/runtime/snapshot/enriched";
import { localMeshStore } from "../../../../bridge/src/mesh/local-remote/local";
import { withDesktopModels } from "../models";
import { MeshSnapshot } from "../../../../../packages/protocol/schema";

/**
 * Selected Mac Mesh: start with durable state, then attach only capabilities
 * from this computer's admitted repository bindings. Avoid the global provider
 * session scan used by the phone publisher.
 */
export async function desktopSelectedMesh(projectId: string): Promise<MeshSnapshot | undefined> {
  const snapshot = localMeshStore().snapshot(projectId);
  if (!snapshot) return undefined;
  const endpointId = computerId();
  const workspaces = (snapshot.bindings ?? [])
    .filter((binding) => binding.endpointId === endpointId
      && binding.available && binding.localPathHint)
    .map((binding) => binding.localPathHint!);
  const skills = projectSharedSkills(workspaces, endpointId).slice(0, 64);
  const mcpServers = configuredProjectMcpServers(endpointId, workspaces).slice(0, 128);
  const local = MeshSnapshot.parse({
    ...snapshot,
    publisherEndpointId: endpointId,
    skills: skills.length > 0 ? skills : undefined,
    mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
  });
  return MeshSnapshot.parse(await enrichMeshSnapshot(withDesktopModels(local)));
}
