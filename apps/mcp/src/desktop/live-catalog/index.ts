import { join } from "node:path";
import { configDir } from "../../../../bridge/src/config/runtime/paths";
import { computerId } from "../../../../bridge/src/mesh/identity/computer";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";
import { scanSessions } from "../../../../bridge/src/sessions";
import type { SessionInfo } from "../../../../../packages/protocol/schema";

/** Native liveness is an observation, independent of durable handoff/close records. */
export function desktopLiveCatalog(
  storePath = join(configDir(), "project-mesh.json"),
  endpointId = computerId(),
  sessions: SessionInfo[] = scanSessions().sessions,
  now = Date.now(),
) {
  const loaded = readStoreState(storePath);
  if (!["ok", "missing"].includes(loaded.status)) return undefined;
  const tasks = new Map(loaded.state.tasks.map(task => [task.taskId, task]));
  const projects = new Set(loaded.state.projects.map(project => project.projectId));
  const result: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const execution = loaded.state.executions.find(item => item.computerId === endpointId
      && item.provider === session.agent && item.sessionId === session.sessionId);
    const task = execution && tasks.get(execution.taskId);
    const key = `${session.agent}\0${session.sessionId}`;
    if (!task || !projects.has(task.projectId) || task.ownerSessionId !== session.sessionId
      || ["completed", "failed", "cancelled", "handoff"].includes(task.state)
      || (execution!.endedAt != null && session.lastActivityAt <= execution!.endedAt)
      || seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...session, projectId: task.projectId, taskId: task.taskId, computerId: endpointId,
      title: session.title?.slice(0, 160), summary: session.summary?.slice(0, 1_000),
      skills: undefined, mcpServers: undefined,
    });
    if (result.length >= 40) break;
  }
  return { operation: "desktop.live_catalog" as const, computer_id: endpointId,
    generated_at: now, sessions: result };
}
