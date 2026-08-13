import { z } from "zod";

export const ScheduledTask = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(180),
  agent: z.enum(["codex", "claude"]),
  prompt: z.string().min(1).max(20_000),
  cwd: z.string().min(1),
  cron: z.string().min(9).max(120),
  enabled: z.boolean(),
  createdAt: z.number(),
  lastRunAt: z.number().optional(),
  nextRunAt: z.number().optional(),
  lastResult: z.string().max(500).optional(),
  lastSessionId: z.string().optional(),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

export const ScheduleRunRecord = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  taskTitle: z.string().min(1).max(180),
  agent: z.enum(["codex", "claude"]),
  trigger: z.enum(["schedule", "manual"]),
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  result: z.string().max(500).optional(),
  sessionId: z.string().optional(),
});
export type ScheduleRunRecord = z.infer<typeof ScheduleRunRecord>;

export const SchedulesStatus = z.object({
  type: z.literal("schedules.status"),
  tasks: z.array(ScheduledTask),
  history: z.array(ScheduleRunRecord).max(200).optional(),
  generatedAt: z.number(),
});
export type SchedulesStatus = z.infer<typeof SchedulesStatus>;

export const ScheduleSet = z.object({
  type: z.literal("schedule.set"),
  task: ScheduledTask.omit({
    lastRunAt: true,
    nextRunAt: true,
    lastResult: true,
    lastSessionId: true,
  }),
  createdAt: z.number(),
});
export type ScheduleSet = z.infer<typeof ScheduleSet>;

export const ScheduleDelete = z.object({
  type: z.literal("schedule.delete"),
  id: z.string(),
  createdAt: z.number(),
});
export type ScheduleDelete = z.infer<typeof ScheduleDelete>;

export const ScheduleRun = z.object({
  type: z.literal("schedule.run"),
  id: z.string(),
  createdAt: z.number(),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const SchedulePlanTurn = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(8_000),
});
export type SchedulePlanTurn = z.infer<typeof SchedulePlanTurn>;

export const SchedulePlanDraft = z.object({
  title: z.string().min(1).max(180),
  prompt: z.string().min(1).max(20_000),
  cron: z.string().min(9).max(120),
});
export type SchedulePlanDraft = z.infer<typeof SchedulePlanDraft>;

export const SchedulePlanRequest = z.object({
  type: z.literal("schedule.plan.request"),
  requestId: z.string().min(1),
  plannerId: z.string().min(1),
  agent: z.enum(["codex", "claude"]),
  cwd: z.string().min(1),
  locale: z.string().max(80).optional(),
  turns: z.array(SchedulePlanTurn).min(1).max(30),
  currentDraft: SchedulePlanDraft.optional(),
  createdAt: z.number(),
});
export type SchedulePlanRequest = z.infer<typeof SchedulePlanRequest>;

export const SchedulePlanResult = z.object({
  type: z.literal("schedule.plan.result"),
  requestId: z.string().min(1),
  plannerId: z.string().min(1),
  ok: z.boolean(),
  message: z.string().min(1).max(8_000),
  draft: SchedulePlanDraft.optional(),
  createdAt: z.number(),
});
export type SchedulePlanResult = z.infer<typeof SchedulePlanResult>;
