import { createInterface } from "node:readline";
import { desktopTaskActivity } from "./task-activity";
import { desktopTaskImage } from "./image";
import { scanCapabilityUsage, scanSessions, scanSessionHistory } from "../../../bridge/src/sessions";
import { desktopSelectedMesh } from "./projection/selected-mesh";
import { desktopUsageSessions } from "./projection/session-usage";
import { desktopLiveCatalog } from "./live-catalog";

let usageCache: { at: number; result: unknown } | undefined;
const activityCache = new Map<string, { at: number; result: ReturnType<typeof desktopTaskActivity> }>();

function cachedActivity(query: unknown, storePath?: string) {
  if (!query || typeof query !== "object") return undefined;
  const input = query as { project_id?: unknown; task_id?: unknown; history_cursor?: unknown };
  if (typeof input.project_id !== "string" || typeof input.task_id !== "string") return undefined;
  const key = JSON.stringify([storePath ?? "", input.project_id, input.task_id, input.history_cursor]);
  const cached = activityCache.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.result;
  const result = desktopTaskActivity(query, storePath);
  if (activityCache.size > 16) activityCache.clear();
  activityCache.set(key, { at: Date.now(), result });
  return result;
}

function cachedUsage(): unknown {
  if (usageCache && Date.now() - usageCache.at < 120_000) return usageCache.result;
  const sessions = [...scanSessions().sessions, ...scanSessionHistory()];
  const result = { ...scanCapabilityUsage(sessions), operation: "desktop.capability_usage",
    sessions: desktopUsageSessions(sessions) };
  usageCache = { at: Date.now(), result };
  return result;
}

process.stdout.write('{"ready":true}\n');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 8_192) continue;
  try {
    const request = JSON.parse(line) as { id: string; query: unknown; storePath?: string };
    const result = request.query && typeof request.query === "object"
      && (request.query as { operation?: string }).operation === "desktop.capability_usage"
      ? cachedUsage()
      : request.query && typeof request.query === "object"
        && (request.query as { operation?: string }).operation === "desktop.live_catalog"
        ? desktopLiveCatalog(request.storePath) ?? null
      : request.query && typeof request.query === "object"
        && (request.query as { operation?: string }).operation === "desktop.mesh_snapshot"
        ? await desktopSelectedMesh(
          (request.query as { project_id: string }).project_id,
          { refreshGraph: (request.query as { refresh_graph?: boolean }).refresh_graph === true }
        ) ?? null
      : request.query && typeof request.query === "object"
        && (request.query as { operation?: string }).operation === "desktop.task_image"
        ? desktopTaskImage(request.query, request.storePath,
          cachedActivity(request.query, request.storePath)) ?? null
      : cachedActivity(request.query, request.storePath) ?? null;
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch {
    process.stdout.write('{"id":null,"result":null}\n');
  }
}
