import { artifactImages, artifactImageChunk } from "./artifacts";
import { desktopTaskActivity } from "../task-activity";
import { codexImageChunk } from "../../../../bridge/src/sessions/scan/codex/activity";

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
  if (activity.agent !== "codex"
    || !activity.entries.some((entry) => entry.id === imageId
      && entry.kind === "user" && entry.attachments?.includes("Image"))) return undefined;
  const chunk = codexImageChunk(activity.session_id, imageId, offset);
  return chunk ? { operation: "desktop.task_image", image_id: imageId, ...chunk } : undefined;
}
