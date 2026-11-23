import { z } from 'zod';
import { CodingAgent } from '../messages/primitives';

const identifier = z.string().min(1).max(256);
const time = z.number().int().nonnegative();
const sentence = z.string().min(1).max(240);

export const AutomationWeekday = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export type AutomationWeekday = z.infer<typeof AutomationWeekday>;

/**
 * When a GrantTap automation sends its message, in the computer's time zone: once at a time, every
 * N hours from when it was saved or resumed, daily at a time on chosen weekdays (none: every day), or
 * a five-field cron expression of numbers, lists, ranges and steps.
 */
export const AutomationSchedule = z.union([
  z.object({ kind: z.literal('once'), at: time.positive() }).strict(),
  z.object({ kind: z.literal('hours'), every: z.number().int().min(1).max(168) }).strict(),
  z.object({ kind: z.literal('daily'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59),
    weekdays: z.array(AutomationWeekday).max(7).refine(days => new Set(days).size === days.length) }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().trim().min(9).max(120) }).strict(),
]);
export type AutomationSchedule = z.infer<typeof AutomationSchedule>;

/** What the person chooses: the message keeps its whitespace exactly. */
export const AutomationDraft = z.object({
  name: z.string().trim().min(1).max(160),
  prompt: z.string().min(1).max(8192).refine(value => value.trim().length > 0),
  schedule: AutomationSchedule,
}).strict();
export type AutomationDraft = z.infer<typeof AutomationDraft>;

/** Why a due run has not gone yet. Readers show a code they do not know as waiting. */
export const AutomationWaitReason = z.string().regex(/^[a-z][a-z-]{0,39}$/);

/** The last run or skip. `reason` is an English sentence the phone may translate. */
export const AutomationOutcome = z.object({
  at: time, outcome: z.enum(['ran', 'skipped', 'failed']), dueAt: time.optional(),
  /** Started with Run now rather than by its schedule. */
  manual: z.boolean().optional(),
  /** Occurrences this skip covers when more than one. */
  count: z.number().int().min(2).max(10_000).optional(),
  reason: sentence.optional(),
}).strict();
export type AutomationOutcome = z.infer<typeof AutomationOutcome>;

export const TaskAutomation = z.object({
  id: identifier, sessionId: identifier, agent: CodingAgent,
  name: z.string().min(1).max(160), prompt: z.string().max(8192), schedule: AutomationSchedule,
  status: z.enum(['ACTIVE', 'PAUSED']),
  /** Changes with every edit the person makes, never with a run. */
  revision: z.number().int().positive(),
  createdAt: time, updatedAt: time,
  /** The next scheduled run; absent while paused and after a one-time run. */
  nextRunAt: time.optional(),
  /** A run that came due and waits for the chat to be free or for its usage limit to reset. */
  waiting: z.object({ dueAt: time, reason: AutomationWaitReason, until: time.optional(), manual: z.boolean().optional() })
    .strict().optional(),
  last: AutomationOutcome.optional(),
}).strict();
export type TaskAutomation = z.infer<typeof TaskAutomation>;

const revised = { id: identifier, revision: z.number().int().positive() };
/** One change. Pause, resume, edit and delete name the revision the phone showed; Run now does not. */
export const TaskAutomationAction = z.union([
  z.object({ kind: z.literal('create'), draft: AutomationDraft }).strict(),
  z.object({ kind: z.literal('update'), ...revised, draft: AutomationDraft }).strict(),
  z.object({ kind: z.literal('pause'), ...revised }).strict(),
  z.object({ kind: z.literal('resume'), ...revised }).strict(),
  z.object({ kind: z.literal('delete'), ...revised }).strict(),
  z.object({ kind: z.literal('run'), id: identifier }).strict(),
]);
export type TaskAutomationAction = z.infer<typeof TaskAutomationAction>;

/**
 * Lists, and with `action` changes, the GrantTap automations of a chat's Task on this computer. On the
 * wire `action` is any object with a `kind`, so a change this computer does not know is answered with
 * a failure instead of silence; `TaskAutomationAction` is the strict form it is applied in.
 */
export const TaskAutomationsRequest = z.object({
  type: z.literal('task.automations'), requestId: identifier, sessionId: identifier,
  createdAt: z.number().finite(),
  action: z.object({ kind: z.string().min(1).max(40) }).passthrough().optional(),
}).strict();
export type TaskAutomationsRequest = z.infer<typeof TaskAutomationsRequest>;

export const TaskAutomationsResult = z.object({
  type: z.literal('task.automations.result'), requestId: identifier, sessionId: identifier,
  phase: z.enum(['completed', 'failed', 'unavailable']),
  automations: z.array(TaskAutomation).max(32),
  /** Rows left out to stay within one reply; the computer refuses changes that would need it. */
  truncated: z.boolean().optional(),
  /** The automation the request created or changed. */
  changedId: identifier.optional(),
  timeZone: z.string().max(100), message: sentence.optional(), createdAt: z.number().finite(),
}).strict().refine(value => new Set(value.automations.map(row => row.id)).size === value.automations.length
  && new TextEncoder().encode(JSON.stringify(value)).length <= 65_536);
export type TaskAutomationsResult = z.infer<typeof TaskAutomationsResult>;
