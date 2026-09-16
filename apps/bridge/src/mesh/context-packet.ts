/**
 * Compact Mesh context for the calling Task.
 *
 * This is GrantTap's own packet, compiled inside Mesh. Cortex Loom may later
 * feed evidence into the same shape as a library. It is not an MCP server.
 */
import type { ScopedMeshView } from "./scoped-view";

export type MeshContextPacket = {
  schema: "granttap.mesh-context.v1";
  taskId: string | null;
  title: string | null;
  state: string | null;
  claims: string[];
  neighbours: string[];
  events: string[];
  otherSide: string[];
};

const MAX_ITEMS = 12;
const MAX_CHARS = 160;

function clip(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS - 1)}…`;
}

export function compileMeshContext(view: ScopedMeshView): MeshContextPacket {
  return {
    schema: "granttap.mesh-context.v1",
    taskId: view.task?.taskId ?? view.execution.taskId ?? null,
    title: view.task?.title ? clip(view.task.title) : null,
    state: view.task?.state ?? null,
    claims: view.claims.slice(0, MAX_ITEMS).map((claim) => clip(claim.resource)),
    neighbours: view.neighbours.slice(0, MAX_ITEMS).map((row) =>
      clip(`${row.kind} ${row.claim.resource}`)),
    events: view.events.slice(-MAX_ITEMS).map((event) =>
      clip(`${event.eventType}${event.payload.summary ? `: ${event.payload.summary}` : ""}`)),
    otherSide: view.otherSide.slice(0, MAX_ITEMS).map((row) =>
      clip(`${row.repositoryId} ${row.title}`)),
  };
}
