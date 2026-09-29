import type { EndpointModelCatalog, MeshSnapshot } from "../../../../../packages/protocol/schema";
import { computerId } from "../../../../bridge/src/mesh/identity/computer";
import { readCodexModelCatalog } from "../../../../bridge/src/provider-model-catalog";

/** Native picker metadata is local to this Mac; discovering it never starts an agent. */
export function desktopModelCatalog(): EndpointModelCatalog {
  return readCodexModelCatalog(computerId());
}

export function withDesktopModels(snapshot: MeshSnapshot,
  catalog = desktopModelCatalog()): MeshSnapshot {
  return { ...snapshot, publisherEndpointId: catalog.endpointId, modelCatalog: [catalog] };
}
