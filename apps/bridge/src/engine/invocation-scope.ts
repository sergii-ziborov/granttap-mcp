import { join } from "node:path";
import { configDir } from "../config/paths";
import type { ExecutionCapability } from "../mesh/capability";
import { EngineClient } from "./engine-client";
import { engineFeatureEnabled } from "./engine-supervisor";
import type { SequencedInvocationEvent } from "./engine-invocation-protocol";

type Client = Pick<EngineClient, "request">;
export type ScopedInvocationSlice = {
  availability: "ready" | "unavailable";
  events: SequencedInvocationEvent[];
  hasOlder: boolean;
};

const client = new EngineClient({ socketPath: join(configDir(), "engine.sock") });

/** One bounded Task slice; the caller's opaque Mesh capability supplies scope. */
export async function scopedInvocationSlice(
  capability: Pick<ExecutionCapability, "projectId" | "taskId">,
  options: { client?: Client; enabled?: () => boolean } = {},
): Promise<ScopedInvocationSlice> {
  if (!(options.enabled ?? engineFeatureEnabled)()) {
    return { availability: "unavailable", events: [], hasOlder: false };
  }
  try {
    const result = await (options.client ?? client).request({
      operation: "invocation.history",
      input: { project_id: capability.projectId, task_id: capability.taskId,
        tail: true, limit: 8 },
    }, { timeoutMs: 500 });
    if (result.operation !== "invocation.history"
      || result.page.events.some((row) => row.event.project_id !== capability.projectId
        || row.event.task_id !== capability.taskId)) throw new Error("history scope mismatch");
    return { availability: "ready", events: result.page.events,
      hasOlder: result.page.has_older };
  } catch {
    return { availability: "unavailable", events: [], hasOlder: false };
  }
}
