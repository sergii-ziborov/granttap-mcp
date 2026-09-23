import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MeshEvent, MeshSnapshot, ProjectKnowledgeRecord } from "../../../../../packages/protocol/schema";
import { configDir } from "../../config/runtime/paths";
import type { KnowledgeRecordInput } from "../protocol/engine-memory-protocol";
import { EngineClient } from "./engine-client";
import { engineFeatureEnabled, type EngineClientLike } from "./engine-supervisor";

type Options = { env?: NodeJS.ProcessEnv; client?: EngineClientLike };
type KnowledgeSourceWindow = Pick<MeshSnapshot, "projectId" | "events">;
let sharedClient: EngineClient | undefined;
const synced = new Set<string>();
const pendingSyncs = new Map<string, Promise<void>>();

function client(options: Options): EngineClientLike {
  return options.client ?? (sharedClient ??= new EngineClient({
    socketPath: join(configDir(), "engine.sock"),
  }));
}

export async function recordProjectKnowledge(
  input: KnowledgeRecordInput, options: Options = {},
): Promise<boolean> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return false;
  try {
    const result = await client(options).request({ operation: "memory.record", input },
      { timeoutMs: 5_000 });
    return result.operation === "memory.recorded" && result.record_id === input.record_id;
  } catch { return false; }
}

export async function projectKnowledge(
  projectId: string, taskId?: string, options: Options = {},
): Promise<ProjectKnowledgeRecord[] | undefined> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return undefined;
  try {
    const result = await client(options).request({
      operation: "memory.history",
      input: { project_id: projectId, task_id: taskId,
        visibility: taskId ? undefined : "project", limit: 64,
        include_superseded: true },
    }, { timeoutMs: 250 });
    if (result.operation !== "memory.history" || result.page.project_id !== projectId) return undefined;
    return result.page.entries.filter((entry) => taskId
      ? entry.task_id === taskId || entry.visibility === "project"
      : entry.visibility === "project").map((entry) => ({
      projectId: entry.project_id, taskId: entry.task_id,
      recordId: entry.record_id, category: entry.category,
      content: entry.content, source: entry.source,
      sourceRef: entry.source_ref, visibility: entry.visibility,
      repositoryId: entry.repository_id ?? undefined,
      commitSha: entry.commit_sha ?? undefined,
      supersedesRecordId: entry.supersedes_record_id ?? undefined,
      recordedAt: entry.recorded_at, streamVersion: entry.stream_version,
    }));
  } catch { return undefined; }
}

/** Preserve source attribution: a Task report is never a verified Project decision. */
export function recordsFromEvent(event: MeshEvent): KnowledgeRecordInput[] {
  const base = {
    project_id: event.projectId, task_id: event.taskId,
    source_ref: event.eventId, recorded_at: event.createdAt,
    commit_sha: event.payload.commitSha,
  };
  if (event.eventType === "HANDOFF_REQUEST" && event.payload.capsule) {
    const capsule = event.payload.capsule;
    return capsule.importantDecisions.map((content, index) => ({
      ...base, record_id: `capsule-${createHash("sha256")
        .update(JSON.stringify([event.eventId, index])).digest("hex")}`,
      category: "decision", content, source: "task_capsule",
      visibility: "project", repository_id: capsule.repository,
      commit_sha: capsule.latestCommit ?? capsule.baseSha,
    }));
  }
  if (event.eventType === "AGENT_ANSWER" && event.payload.answer) {
    return [{ ...base, record_id: event.eventId, category: "decision",
      content: event.payload.answer, source: "agent_report", visibility: "task" }];
  }
  if (event.eventType === "TASK_COMPLETED" && event.payload.summary) {
    return [{ ...base, record_id: event.eventId, category: "result",
      content: event.payload.summary, source: "agent_report", visibility: "project" }];
  }
  if (event.eventType === "TASK_BLOCKED" && event.payload.reason) {
    return [{ ...base, record_id: event.eventId, category: "attempt",
      content: event.payload.reason, source: "agent_report", visibility: "task" }];
  }
  return [];
}

/** Backfill retained structured events; a failed Engine write stops this pass. */
export async function syncProjectKnowledge(snapshot: KnowledgeSourceWindow, options: Options = {}): Promise<void> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return;
  const candidates = snapshot.events.flatMap(recordsFromEvent)
    .filter((entry) => entry.project_id === snapshot.projectId
      && !synced.has(`${entry.project_id}\0${entry.record_id}`))
    .slice(-512);
  if (candidates.length === 0) return;
  for (const [index, entry] of candidates.entries()) {
    if (index > 0 && index % 16 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const key = `${entry.project_id}\0${entry.record_id}`;
    if (!await recordProjectKnowledge(entry, options)) break;
    synced.add(key);
    if (synced.size > 4_096) synced.delete(synced.values().next().value!);
  }
}

/** Publish never waits for the memory backfill; one bounded writer runs per Project. */
export function queueProjectKnowledgeSync(snapshot: KnowledgeSourceWindow): void {
  if (pendingSyncs.has(snapshot.projectId)) return;
  const pending = syncProjectKnowledge(snapshot);
  pendingSyncs.set(snapshot.projectId, pending);
  void pending.catch(() => undefined).finally(() => {
    if (pendingSyncs.get(snapshot.projectId) === pending) pendingSyncs.delete(snapshot.projectId);
  });
}
