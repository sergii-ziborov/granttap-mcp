import { join } from "node:path";
import { configDir } from "../../../../bridge/src/config/runtime/paths";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";
import type { EngineClient } from "../../../../bridge/src/engine/runtime/engine-client";

/** Local, content-free Engine history for one persisted Mesh Task. */
export async function desktopInvocationHistory(
  input: unknown, engine: Pick<EngineClient, "request">,
  storePath = join(configDir(), "project-mesh.json"),
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { project_id: projectId, task_id: taskId } = input as Record<string, unknown>;
  if (typeof projectId !== "string" || !projectId || projectId.length > 128
    || typeof taskId !== "string" || !taskId || taskId.length > 128) return undefined;
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok" || !loaded.state.tasks.some((task) =>
    task.projectId === projectId && task.taskId === taskId)) return undefined;
  const read = (timeoutMs: number) => engine.request({ operation: "invocation.history",
    input: { project_id: projectId, task_id: taskId, tail: true, limit: 16 } },
  { timeoutMs });
  try {
    let result;
    try {
      result = await read(3_000);
    } catch {
      result = await read(6_000);
    }
    if (result.operation !== "invocation.history"
      || result.page.events.some((row) => row.event.project_id !== projectId
        || row.event.task_id !== taskId)) return undefined;
    return { operation: "desktop.invocation_history" as const,
      project_id: projectId, task_id: taskId, events: result.page.events,
      has_older: result.page.has_older };
  } catch {
    return { operation: "desktop.invocation_history" as const,
      project_id: projectId, task_id: taskId, events: [], has_older: false,
      unavailable: true };
  }
}
