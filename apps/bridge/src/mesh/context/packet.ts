import { cortexContextForView } from "../../cortex/integration";
import { loadRuntimeConfig } from "../../config/runtime";
import type { ScopedMeshView } from "../snapshot/scoped-view";

export type MeshContextPacket = {
  schema: "granttap.mesh-context.v2";
  taskId: string;
  state: "disabled" | "unavailable" | "succeeded" | "degraded";
  compiler: "cortex-context";
  version?: string;
  revision?: string;
  packetId?: string;
  snapshotId?: string;
  content?: string;
  included?: string[];
  omitted?: string[];
  rawEstimatedTokens?: number;
  selectedEstimatedTokens?: number;
  omittedEstimatedTokens?: number;
  deduplicatedLines?: number;
  requiresUpstream?: boolean;
};

/** Compile the permitted Task evidence through the linked Cortex library. */
export async function compileMeshContext(view: ScopedMeshView): Promise<MeshContextPacket> {
  const taskId = view.task?.taskId ?? view.execution.taskId;
  const enabled = loadRuntimeConfig().cortexByProject[view.project.projectId]?.enabled === true;
  if (!enabled) return {
    schema: "granttap.mesh-context.v2", taskId, state: "disabled", compiler: "cortex-context",
  };
  const compilation = await cortexContextForView(view);
  if (!compilation) return {
    schema: "granttap.mesh-context.v2", taskId, state: "unavailable", compiler: "cortex-context",
  };
  const packet = compilation.packet;
  return {
    schema: "granttap.mesh-context.v2",
    taskId,
    state: packet.requires_upstream ? "degraded" : "succeeded",
    compiler: "cortex-context",
    version: compilation.cortex_version,
    revision: compilation.cortex_revision,
    packetId: packet.packet_id ?? undefined,
    snapshotId: packet.snapshot_id ?? undefined,
    content: packet.content,
    included: packet.included_ids,
    omitted: packet.omitted_ids,
    rawEstimatedTokens: packet.raw_estimated_tokens,
    selectedEstimatedTokens: packet.selected_estimated_tokens,
    omittedEstimatedTokens: packet.omitted_estimated_tokens,
    deduplicatedLines: packet.deduplicated_lines,
    requiresUpstream: packet.requires_upstream,
  };
}
