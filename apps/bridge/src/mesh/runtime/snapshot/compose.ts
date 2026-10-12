import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";
import type { MeshRuntimeDependencies } from "../dependencies";
import { catalogFromEndpoint } from "../../catalog/models";
import { projectMcpServers } from "../../catalog/project/capabilities";
import { configuredProjectMcpServers, mergeConfiguredMcpServers } from "../../catalog/project/configured-mcp";
import { projectCapabilityObservations } from "../../catalog/project/observations";
import { projectExecutionCapabilitySessions } from "../capabilities";

export function composeMeshSnapshot(
    deps: MeshRuntimeDependencies,
    projectId: string,
    store = deps.store(),
    sessions = deps.sessions(),
    models = catalogFromEndpoint(deps.computer(), sessions),
  ): MeshSnapshot | undefined {
    const snapshot = store.snapshot(projectId, deps.computer());
    if (!snapshot) return undefined;
    const linked = projectExecutionCapabilitySessions(
      snapshot, sessions, deps.computer(), deps.capabilityInventory,
    );
    const reported = projectMcpServers(
      linked.filter((session) => session.computerId === deps.computer()), projectId,
    );
    const workspaces = (snapshot.bindings ?? [])
      .filter((binding) => binding.endpointId === deps.computer()
        && binding.available && binding.localPathHint)
      .map((binding) => binding.localPathHint!);
    const mcpServers = mergeConfiguredMcpServers(
      configuredProjectMcpServers(deps.computer(), workspaces), reported,
    );
    const capabilityObservations = projectCapabilityObservations({
      projectId, endpointId: deps.computer(), bound: workspaces.length > 0,
      requests: snapshot.capabilityRequests ?? [], skills: snapshot.skills ?? [],
      mcpServers, now: deps.now(),
    });
    return {
      ...snapshot,
      publisherEndpointId: deps.computer(),
      mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
      capabilityObservations: capabilityObservations.length > 0
        ? capabilityObservations : undefined,
      modelCatalog: models.models.length > 0 || models.reason ? [models] : undefined,
    };
  }

