import { join } from "node:path";
import { z } from "zod";
import { configDir } from "../../../../bridge/src/config";
import { observedComputerId } from "../../../../bridge/src/mesh/identity/computer";
import { compactTaskSession, controlTaskSession } from "../../../../bridge/src/task-control";
import { localTaskSession } from "../delivery/task-scope";

const Query = z.object({ project_id: z.string(), task_id: z.string(), session_id: z.string(),
  action: z.enum(["pause", "resume", "compact"]), continue: z.boolean().optional() }).strict();

/** Local controls never use a relay route or accept another computer's execution. */
export async function desktopTaskControl(input: unknown, options: {
  storePath?: string; endpointId?: string;
} = {}) {
  const parsed = Query.safeParse(input);
  if (!parsed.success) return undefined;
  const query = parsed.data;
  if (!localTaskSession(query, options.storePath ?? join(configDir(), "project-mesh.json"),
    options.endpointId ?? observedComputerId())) return undefined;
  let result: { type: string; sessionId: string; action?: string; ok: boolean; message: string; createdAt: number } | undefined;
  const reply = async (ok: boolean, message: string) => {
    result = { type: query.action === "compact" ? "session.compact.result" : "session.control.result",
      sessionId: query.session_id, ...(query.action === "compact" ? {} : { action: query.action }),
      ok, message: message.slice(0, 1_000), createdAt: Date.now() };
  };
  if (query.action === "compact") await compactTaskSession(query.session_id, reply);
  else await controlTaskSession({ type: "session.control", sessionId: query.session_id,
    action: query.action, continue: query.continue, createdAt: Date.now() }, reply);
  return { operation: "desktop.task_control", result };
}
