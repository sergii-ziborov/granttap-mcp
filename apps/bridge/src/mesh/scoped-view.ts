/**
 * The caller-scoped Mesh view.
 *
 * Coordination needs the calling execution's own Project, not everything this
 * computer happens to know. Other Projects — their Tasks, goals, repositories,
 * branches, session ids and events — never enter a scoped read.
 */
import type { MeshEvent, MeshSnapshot } from "../../../../packages/protocol/schema";
import type { ExecutionCapability } from "./capability";
import { liveExecutionScope } from "./capability";

const MAX_SCOPED_EVENTS = 32;

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
  dependencies: MeshSnapshot["dependencies"];
  events: MeshEvent[];
  allowedEventTypes: string[];
};

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
    dependencies: snapshot.dependencies,
    events: scopedEvents(snapshot, capability),
    allowedEventTypes: capability.allowedEventTypes,
  };
}
