import { join } from "node:path";
import { configDir } from "../../../bridge/src/config/runtime/paths";
import { readStoreState } from "../../../bridge/src/mesh/store/state";
import { scanSessionActivity } from "../../../bridge/src/sessions";
import type { SessionActivity, SessionInfo } from "../../../../packages/protocol/schema";

type ActivitySources = {
  sessions?: () => SessionInfo[];
  activity?: (session: SessionInfo) => SessionActivity;
};

/** One Task's native conversation, resolved through its exact Mesh execution links. */
export function desktopTaskActivity(
  input: unknown,
  storePath = join(configDir(), "project-mesh.json"),
  sources: ActivitySources = {},
) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { project_id: projectId, task_id: taskId } = input as Record<string, unknown>;
  if (typeof projectId !== "string" || !projectId || projectId.length > 128
    || typeof taskId !== "string" || !taskId || taskId.length > 128) return undefined;
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok") return undefined;
  const tasksWithId = loaded.state.tasks.filter((task) => task.taskId === taskId);
  if (tasksWithId.length !== 1 || tasksWithId[0]?.projectId !== projectId) return undefined;
  const links = loaded.state.executions.filter((item) => item.taskId === taskId)
    .sort((left, right) => right.startedAt - left.startedAt);
  const sessions = sources.sessions?.() ?? links.map((link): SessionInfo => ({
    sessionId: link.sessionId, agent: link.provider, cwd: link.workspace,
    state: link.endedAt === undefined ? "working" : "idle",
    startedAt: link.startedAt,
    lastActivityAt: link.activeAt ?? link.updatedAt ?? link.startedAt,
    tokensSession: 0, tokensLastTurn: 0,
  }));
  const matched = links.flatMap((link) => sessions.filter((session) =>
    session.sessionId === link.sessionId && session.agent === link.provider))[0];
  const activity = matched ? (sources.activity ?? scanSessionActivity)(matched) : undefined;
  const rootEntries = activity?.entries.filter((entry) => !entry.childThreadId) ?? [];
  const entries = rootEntries.slice(-48).map((entry) => ({
    id: entry.id.slice(0, 256), kind: entry.kind,
    text: entry.text.slice(0, 2_048), created_at: entry.createdAt,
    tool_name: entry.toolName?.slice(0, 160) ?? null,
    summary: entry.summary?.slice(0, 200) ?? null,
  }));
  return {
    operation: "desktop.task_activity" as const,
    project_id: projectId, task_id: taskId,
    session_id: matched?.sessionId ?? null,
    agent: matched?.agent ?? null,
    state: activity?.state ?? null,
    entries, truncated: rootEntries.length > entries.length,
  };
}
