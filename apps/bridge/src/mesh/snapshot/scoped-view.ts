/**
 * The caller-scoped Mesh view.
 *
 * Coordination needs the calling execution's own Project, not everything this
 * computer happens to know. Other Projects — their Tasks, goals, repositories,
 * branches, session ids and events — never enter a scoped read.
 */
import type { MeshEvent, MeshSnapshot, ResourceClaim } from "../../../../../packages/protocol/schema";
import type { ExecutionCapability } from "../catalog/capability";
import { liveExecutionScope } from "../catalog/capability";
import { otherSide, type OtherSideRow } from "../handoff/other-side";
import { scopedOverlapKind } from "../store/support";

const MAX_SCOPED_EVENTS = 32;
const MAX_NEIGHBOURS = 32;

export type ScopedMeshView = {
  schema: "granttap.mesh-scope.v1";
  generatedAt: number;
  execution: MeshSnapshot["executions"][number];
  project: MeshSnapshot["project"];
  task: MeshSnapshot["tasks"][number] | null;
  peerTasks: Array<{
    taskId: string;
    title: string;
    state: string;
    ownerSessionId?: string;
  }>;
  executions: MeshSnapshot["executions"];
  claims: MeshSnapshot["claims"];
  /** Another Task's claim on a file this Task holds, or on the same module. */
  neighbours: Array<{ claim: ResourceClaim; kind: "file" | "logical_file" | "module" }>;
  /** Verified topology and per-repository Weavatrix Rust analysis. */
  backbone?: MeshSnapshot["backbone"];
  repositoryGraphs?: NonNullable<MeshSnapshot["repositoryGraphs"]>;
  /** Legacy compatibility edges from computers that have not migrated yet. */
  peers: NonNullable<MeshSnapshot["peers"]>;
  skills?: NonNullable<MeshSnapshot["skills"]>;
  mcpServers?: NonNullable<MeshSnapshot["mcpServers"]>;
  capabilityRequests?: NonNullable<MeshSnapshot["capabilityRequests"]>;
  modelCatalog?: NonNullable<MeshSnapshot["modelCatalog"]>;
  executionPolicy?: MeshSnapshot["execution"];
  restrictions?: MeshSnapshot["restrictions"];
  environment?: MeshSnapshot["environment"];
  cortex?: NonNullable<MeshSnapshot["cortex"]>;
  /** Other Tasks working right now on the far side of this Task's repository. */
  otherSide: OtherSideRow[];
  dependencies: MeshSnapshot["dependencies"];
  events: MeshEvent[];
  allowedEventTypes: string[];
};

/** Claims held by other Tasks that touch this Task's files, or its modules. */
export function scopedNeighbours(
  snapshot: Pick<MeshSnapshot, "claims">,
  taskId: string,
): ScopedMeshView["neighbours"] {
  const mine = snapshot.claims.filter((claim) => claim.taskId === taskId);
  return snapshot.claims
    .filter((claim) => claim.taskId !== taskId)
    .flatMap((claim) => {
      const kinds = mine.flatMap((ours) => {
        const kind = scopedOverlapKind(ours, claim);
        return kind ? [kind] : [];
      });
      const kind = kinds.includes("file") ? "file"
        : kinds.includes("logical_file") ? "logical_file" : kinds[0];
      return kind ? [{ claim, kind }] : [];
    })
    .slice(0, MAX_NEIGHBOURS);
}

/** Events this execution may act on: its own Task, plus anything addressed to it. */
function scopedEvents(snapshot: MeshSnapshot, capability: ExecutionCapability): MeshEvent[] {
  return snapshot.events
    .filter((event) =>
      event.taskId === capability.taskId
      || event.targetSessionId === capability.sessionId
      || event.sourceSessionId === capability.sessionId)
    .slice(-MAX_SCOPED_EVENTS);
}

export function scopedMeshView(
  capability: ExecutionCapability,
  now = Date.now(),
): ScopedMeshView | undefined {
  const scope = liveExecutionScope(capability.sessionId);
  if (!scope || scope.snapshot.projectId !== capability.projectId) return undefined;
  const { snapshot, execution } = scope;
  const task = snapshot.tasks.find((item) => item.taskId === capability.taskId) ?? null;
  return {
    schema: "granttap.mesh-scope.v1",
    generatedAt: now,
    execution,
    project: snapshot.project,
    task,
    // Peer Tasks stay identifiable for dependencies and claims without
    // republishing another Task's full goal text.
    peerTasks: snapshot.tasks
      .filter((item) => item.taskId !== capability.taskId)
      .map((item) => ({
        taskId: item.taskId,
        title: item.title,
        state: item.state,
        ownerSessionId: item.ownerSessionId,
      })),
    executions: snapshot.executions,
    claims: snapshot.claims,
    neighbours: scopedNeighbours(snapshot, capability.taskId),
    backbone: snapshot.backbone,
    repositoryGraphs: snapshot.repositoryGraphs ?? [],
    peers: snapshot.peers ?? [],
    skills: snapshot.skills ?? [],
    mcpServers: snapshot.mcpServers ?? [],
    capabilityRequests: snapshot.capabilityRequests ?? [],
    modelCatalog: snapshot.modelCatalog ?? [],
    executionPolicy: snapshot.execution,
    restrictions: snapshot.restrictions,
    environment: snapshot.environment,
    cortex: snapshot.cortex ?? [],
    otherSide: otherSide(snapshot, capability.taskId),
    dependencies: snapshot.dependencies,
    events: scopedEvents(snapshot, capability),
    allowedEventTypes: capability.allowedEventTypes,
  };
}
