import { join } from "node:path";
import { configDir } from "../../../bridge/src/config/runtime/paths";
import { readStoreState } from "../../../bridge/src/mesh/store/state";
import { scanSessionActivity } from "../../../bridge/src/sessions";
import { codexActivity } from "../../../bridge/src/sessions/scan/codex";
import type { SessionActivity, SessionInfo } from "../../../../packages/protocol/schema";

import { artifactImages } from "./image/artifacts";

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
  const activity = matched ? sources.activity?.(matched)
    ?? (matched.agent === "codex"
      ? { entries: codexActivity(matched), state: matched.state }
      : scanSessionActivity(matched)) : undefined;
  const rootEntries = activity?.entries.filter((entry) => !entry.childThreadId) ?? [];
  const candidates = rootEntries.slice(-256).map((entry) => ({
    id: entry.id.slice(0, 256), kind: entry.kind,
    text: entry.text.slice(0, 16_384), created_at: entry.createdAt,
    tool_name: entry.toolName?.slice(0, 160) ?? null,
    summary: entry.summary?.slice(0, 200) ?? null,
    attachments: entry.attachments ?? null,
    images: artifactImages({ ...entry, text: entry.text.slice(0, 16_384) })
      .map(({ id, name, markdown }) => ({ id, name, markdown })),
  }));
  const entries: typeof candidates = [];
  let bytes = 0;
  for (const entry of candidates.reverse()) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + size > 480 * 1024) break;
    bytes += size;
    entries.unshift(entry);
  }
  return {
    operation: "desktop.task_activity" as const,
    project_id: projectId, task_id: taskId,
    session_id: matched?.sessionId ?? null,
    agent: matched?.agent ?? null,
    state: activity?.state ?? null,
    entries, truncated: rootEntries.length > entries.length,
  };
}
