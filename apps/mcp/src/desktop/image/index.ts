import { artifactImages, artifactImageChunk } from "./artifacts";
import { desktopTaskActivity } from "../task-activity";
import type { ActivityEntry, SessionInfo, SessionActivity } from '../../../../../packages/protocol/schema';
import { nativeTranscriptImage } from '../../../../bridge/src/transcript-history';
import { readStoreState } from '../../../../bridge/src/mesh/store/state';
import { configDir } from '../../../../bridge/src/config';
import { join } from 'node:path';

export function transcriptImages(entry: ActivityEntry) {
  return artifactImages(entry).map(({ id, name, markdown }) => ({ id, name, markdown }));
}

export function sessionImageChunk(session: SessionInfo, activity: SessionActivity,
  imageId: string, offset: number, cursor?: string, storePath?: string) {
  if (activity.sessionId !== session.sessionId) return undefined;
  const native = activity.entries.some(entry => entry.id === imageId && entry.kind === 'user'
    && entry.attachments?.includes('Image'));
  if (native) return nativeTranscriptImage(session, imageId, offset, cursor);
  const artifact = activity.entries.flatMap(artifactImages).find(image => image.id === imageId);
  if (!artifact) return undefined;
  const loaded = readStoreState(storePath ?? join(configDir(), 'project-mesh.json'));
  if (loaded.status !== 'ok') return undefined;
  const links = loaded.state.executions.filter(link => link.sessionId === session.sessionId
    && link.provider === session.agent);
  const taskIds = new Set(links.map(link => link.taskId));
  if (taskIds.size !== 1) return undefined;
  const tasks = loaded.state.tasks.filter(task => taskIds.has(task.taskId));
  if (tasks.length !== 1) return undefined;
  return artifactImageChunk({ projectId: tasks[0]!.projectId, taskId: tasks[0]!.taskId,
    sessionId: session.sessionId, provider: session.agent, image: artifact, offset, storePath });
}

/** Only an image row in the exact Task's linked native conversation is readable. */
export function desktopTaskImage(input: unknown, storePath?: string,
  cachedActivity?: ReturnType<typeof desktopTaskActivity>) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const query = input as Record<string, unknown>;
  const imageId = query.image_id;
  const offset = typeof query.offset === "string" ? Number(query.offset) : query.offset;
  if (typeof imageId !== "string" || imageId.length > 512
    || typeof offset !== "number" || !Number.isSafeInteger(offset)
    || offset < 0) return undefined;
  const activity = cachedActivity ?? desktopTaskActivity(query, storePath);
  if (!activity?.session_id || !activity.agent
    || activity.project_id !== query.project_id || activity.task_id !== query.task_id) return undefined;
  const artifact = activity.entries.flatMap(artifactImages).find((image) => image.id === imageId);
  if (artifact) {
    const chunk = artifactImageChunk({ projectId: activity.project_id, taskId: activity.task_id,
      sessionId: activity.session_id, provider: activity.agent, image: artifact, offset, storePath });
    return chunk ? { operation: "desktop.task_image", image_id: imageId, ...chunk } : undefined;
  }
  if (!["codex", "claude"].includes(activity.agent)
    || !activity.entries.some((entry) => entry.id === imageId
      && entry.kind === "user" && entry.attachments?.includes("Image"))) return undefined;
  const cursor = query.history_cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 512)) return undefined;
  const session: SessionInfo = { sessionId: activity.session_id, agent: activity.agent,
    state: "idle", startedAt: 0, lastActivityAt: 0, tokensSession: 0, tokensLastTurn: 0 };
  const chunk = nativeTranscriptImage(session, imageId, offset, cursor as string | undefined);
  return chunk ? { operation: "desktop.task_image", image_id: imageId, ...chunk } : undefined;
}
