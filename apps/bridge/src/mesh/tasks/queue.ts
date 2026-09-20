import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../config/runtime/paths";
import { writePrivateFile } from "../../config/access/write-private";

export type QueuedTask = {
  operationId: string;
  projectId: string;
  text: string;
  cwd: string;
  agent?: string;
  model?: string;
  deadline: number;
};

type File = { items: QueuedTask[] };

const DEFAULT_QUEUE_MS = 24 * 60 * 60_000;

export function taskQueuePath(): string {
  return join(configDir(), "pinned-task-queue.json");
}

function load(): QueuedTask[] {
  try {
    const raw = JSON.parse(readFileSync(taskQueuePath(), "utf8")) as File;
    return Array.isArray(raw.items) ? raw.items : [];
  } catch {
    return [];
  }
}

function save(items: QueuedTask[]): void {
  writePrivateFile(taskQueuePath(), `${JSON.stringify({ items }, null, 2)}\n`);
}

export function enqueuePinnedTask(item: Omit<QueuedTask, "deadline">, now = Date.now()): QueuedTask {
  const queued = { ...item, deadline: now + DEFAULT_QUEUE_MS };
  const items = load().filter((row) => row.operationId !== item.operationId);
  save([...items, queued]);
  return queued;
}

export function dueQueuedTasks(now = Date.now()): QueuedTask[] {
  const items = load();
  const due = items.filter((item) => item.deadline > now);
  const expired = items.filter((item) => item.deadline <= now);
  if (expired.length) save(due);
  return due;
}

export function dropQueuedTask(operationId: string): void {
  save(load().filter((item) => item.operationId !== operationId));
}
