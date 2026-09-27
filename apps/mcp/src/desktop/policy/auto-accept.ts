import { randomUUID } from "node:crypto";
import { AutoAcceptLevel } from "../../../../../packages/protocol/schema";
import { applyConfigSet, currentConfigRevision } from "../../../../bridge/src/config/commands";
import { loadRuntimeConfig } from "../../../../bridge/src/config/runtime";
import { currentInstanceEpoch } from "../../../../bridge/src/host/instance-epoch";
import { desktopPolicyScope, type DesktopPolicyScopeOptions } from "./scope";

export function desktopProjectAutoAccept(input: unknown, options: DesktopPolicyScopeOptions = {}) {
  const scope = desktopPolicyScope(input, options);
  if (!scope) return undefined;
  const { query, projectId, endpointId } = scope;
  if (query.level !== undefined) {
    const parsed = AutoAcceptLevel.safeParse(query.level);
    if (!parsed.success) return undefined;
    const result = applyConfigSet({ type: "config.set", createdAt: Date.now(), autoAcceptProject: {
      projectId, level: parsed.data,
    }, operationId: randomUUID(), baseRevision: currentConfigRevision(),
    instanceEpoch: currentInstanceEpoch(), expiresAt: Date.now() + 60_000 });
    if (result.kind === "rejected") throw new Error("Mesh auto-accept update was refused");
  }
  const runtime = loadRuntimeConfig();
  return { operation: "desktop.project_auto_accept" as const, project_id: projectId,
    endpoint_id: endpointId, level: runtime.autoAcceptByProject[projectId]
      ?? runtime.autoAcceptDefault, paused: runtime.autoAcceptPaused };
}
