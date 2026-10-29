import { z } from 'zod';

const identifier = z.string().min(1).max(256);
export const TaskSchedulePatch = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().min(1).max(8192).refine(value => value.trim().length > 0).optional(),
  rrule: z.string().trim().min(1).max(1024).optional(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'An edit must change a supported field');
export type TaskSchedulePatch = z.infer<typeof TaskSchedulePatch>;
export const TaskSchedule = z.object({
  id: identifier, sessionId: identifier, name: z.string().min(1).max(160),
  prompt: z.string().max(8192), rrule: z.string().max(1024),
  status: z.enum(['ACTIVE', 'PAUSED']), revision: z.string().regex(/^[a-f0-9]{64}$/),
  editable: z.boolean(), confirmation: z.enum(['confirmed', 'waiting', 'unavailable']),
  reason: z.string().max(240).optional(),
}).strict();
export type TaskSchedule = z.infer<typeof TaskSchedule>;
export const TaskSchedulesRequest = z.object({
  type: z.literal('task.schedules'), requestId: identifier, sessionId: identifier,
  createdAt: z.number().finite(),
  change: z.object({ id: identifier, revision: z.string().regex(/^[a-f0-9]{64}$/), patch: TaskSchedulePatch }).strict().optional(),
}).strict();
export type TaskSchedulesRequest = z.infer<typeof TaskSchedulesRequest>;
export const TaskSchedulesResult = z.object({
  type: z.literal('task.schedules.result'), requestId: identifier, sessionId: identifier,
  phase: z.enum(['completed', 'waiting', 'failed', 'unavailable']),
  schedules: z.array(TaskSchedule).max(32), truncated: z.boolean(),
  timeZone: z.string().max(100), message: z.string().max(240).optional(), createdAt: z.number().finite(),
}).strict().refine(value => new Set(value.schedules.map(row => row.id)).size === value.schedules.length
  && new TextEncoder().encode(JSON.stringify(value)).length <= 65_536);
export type TaskSchedulesResult = z.infer<typeof TaskSchedulesResult>;
