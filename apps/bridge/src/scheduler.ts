/** Terminal-free local schedules shared by Codex and Claude Code. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScheduledTask as ScheduledTaskSchema, type ScheduleSet, type ScheduledTask } from "../../../packages/protocol/schema";
import { configDir } from "./config";
import { createClaudeSession, createCodexSession } from "./reply";

const inFlight = new Set<string>();

export function schedulesPath(): string {
  return join(configDir(), "schedules.json");
}

export function loadSchedules(): ScheduledTask[] {
  try {
    const raw = JSON.parse(readFileSync(schedulesPath(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const parsed = ScheduledTaskSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

function saveSchedules(tasks: ScheduledTask[]): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(schedulesPath(), `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
}

export function scheduledSnapshot(now = Date.now()): ScheduledTask[] {
  return loadSchedules()
    .map((task) => ({
      ...task,
      nextRunAt: task.enabled ? nextOccurrence(task.cron, now) : undefined,
    }))
    .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
}

export function setSchedule(message: ScheduleSet): boolean {
  if (nextOccurrence(message.task.cron, Date.now()) == null) return false;
  const tasks = loadSchedules();
  const index = tasks.findIndex((task) => task.id === message.task.id);
  const existing = index >= 0 ? tasks[index] : undefined;
  const next: ScheduledTask = { ...existing, ...message.task };
  if (index >= 0) tasks[index] = next;
  else tasks.push(next);
  saveSchedules(tasks);
  return true;
}

export function deleteSchedule(id: string): void {
  saveSchedules(loadSchedules().filter((task) => task.id !== id));
}

export function runScheduleNow(id: string): boolean {
  const task = loadSchedules().find((item) => item.id === id);
  if (!task || inFlight.has(id)) return false;
  startTask(task);
  return true;
}

/** Called by the elected monitor every few seconds; starts each minute once. */
export function tickSchedules(now = Date.now()): void {
  const minute = Math.floor(now / 60_000) * 60_000;
  for (const task of loadSchedules()) {
    if (!task.enabled || inFlight.has(task.id)) continue;
    if (cronMatches(task.cron, new Date(now)) && (task.lastRunAt ?? 0) < minute) startTask(task, minute);
  }
}

function startTask(task: ScheduledTask, startedAt = Date.now()): void {
  inFlight.add(task.id);
  updateRun(task.id, { lastRunAt: startedAt, lastResult: "Running…" });
  const run = task.agent === "claude"
    ? createClaudeSession(task.prompt, task.cwd)
    : createCodexSession(task.prompt, task.cwd);
  void run
    .then((result) => {
      updateRun(task.id, result.ok
        ? {
            lastResult: result.text.replace(/\s+/g, " ").trim().slice(0, 500),
            lastSessionId: result.sessionId,
          }
        : { lastResult: `Failed: ${result.error}` });
    })
    .finally(() => inFlight.delete(task.id));
}

function updateRun(id: string, patch: Partial<ScheduledTask>): void {
  const tasks = loadSchedules();
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return;
  tasks[index] = { ...tasks[index]!, ...patch };
  saveSchedules(tasks);
}

type Field = { matches: (value: number) => boolean; wildcard: boolean };

function parseField(source: string, min: number, max: number): Field | null {
  const wildcard = source === "*";
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const [rawRange, stepSource] = part.split("/");
    const rangeSource = rawRange ?? "";
    const step = stepSource == null ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step <= 0) return null;
    let start = min;
    let end = max;
    if (rangeSource !== "*") {
      const range = rangeSource.split("-").map(Number);
      if (range.some((value) => !Number.isInteger(value))) return null;
      start = range[0]!;
      end = range.length === 1 ? start : range[1]!;
    }
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { wildcard, matches: (value) => values.has(value) };
}

function parsedCron(cron: string): Field[] | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  const parsed = fields.map((field, index) =>
    parseField(field!, ranges[index]![0], ranges[index]![1]),
  );
  return parsed.every(Boolean) ? parsed as Field[] : null;
}

export function cronMatches(cron: string, date: Date): boolean {
  const parsed = parsedCron(cron);
  if (!parsed) return false;
  const [minute, hour, day, month, weekday] = parsed;
  const timeMatches = minute!.matches(date.getMinutes())
    && hour!.matches(date.getHours())
    && month!.matches(date.getMonth() + 1);
  const dom = day!.matches(date.getDate());
  const dow = weekday!.matches(date.getDay()) || (date.getDay() === 0 && weekday!.matches(7));
  const dateMatches = !day!.wildcard && !weekday!.wildcard ? dom || dow : dom && dow;
  return timeMatches && dateMatches;
}

export function nextOccurrence(cron: string, after: number): number | undefined {
  if (!parsedCron(cron)) return undefined;
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = candidate + 366 * 24 * 60 * 60_000;
  while (candidate <= limit) {
    if (cronMatches(cron, new Date(candidate))) return candidate;
    candidate += 60_000;
  }
  return undefined;
}
