import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { withStoreLock } from '../../../../packages/core/store-file-lock';
import { AutomationOutcome, AutomationSchedule, AutomationWaitReason, CodingAgent, type TaskAutomation }
  from '../../../../packages/protocol/schema';
import { configDir, writePrivateFile } from '../config';

const time = z.number().int().nonnegative();
const scope = z.string().min(1).max(256);

/** One automation as this computer keeps it: the person's choices and where its schedule stands. */
const Stored = z.object({
  id: z.string().regex(/^gta-[a-f0-9]{16}$/), sessionId: scope, agent: CodingAgent,
  /** The chat's Task, so the Task's other chats list it even when the chat leaves the catalog. */
  projectId: scope.optional(), taskId: scope.optional(),
  name: z.string().min(1).max(160), prompt: z.string().min(1).max(8192), schedule: AutomationSchedule,
  status: z.enum(['ACTIVE', 'PAUSED']), revision: z.number().int().positive(), createdAt: time, updatedAt: time,
  /** Every-N-hours schedules count from here: when it was saved, its schedule edited or it was resumed. */
  anchorAt: time,
  /** The next scheduled run not yet taken up; absent while paused and after a one-time run. */
  nextRunAt: time.optional(),
  /** A run that came due (or Run now) and has not gone yet. There is never more than one. */
  pending: z.object({ dueAt: time, since: time, manual: z.boolean().optional() }).strict().optional(),
  /** Why the pending run waited at the last look. */
  waiting: z.object({ reason: AutomationWaitReason, until: time.optional() }).strict().optional(),
  last: AutomationOutcome.optional(),
}).strict();
export type StoredAutomation = z.infer<typeof Stored>;

/** The automations, and rows a newer GrantTap wrote that this one cannot read: they are kept as they are. */
export type AutomationState = { automations: StoredAutomation[]; kept: unknown[] };

const VERSION = 1, MAX_ROWS = 256;
export const automationsPath = (): string => join(configDir(), 'task-automations.json');

/** Saved automations that cannot be read or are a newer format are never replaced by this computer. */
export class AutomationStoreError extends Error {}

export function readAutomations(path = automationsPath()): AutomationState {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { automations: [], kept: [] };
    throw new AutomationStoreError(`the saved automations could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let saved: unknown;
  try { saved = JSON.parse(raw); } catch { throw new AutomationStoreError('the saved automations are not readable JSON'); }
  const file = z.object({ version: z.literal(VERSION), automations: z.array(z.unknown()).max(MAX_ROWS) }).strict().safeParse(saved);
  if (!file.success) throw new AutomationStoreError('the saved automations are in a format this GrantTap does not know');
  const state: AutomationState = { automations: [], kept: [] };
  for (const row of file.data.automations) {
    const parsed = Stored.safeParse(row);
    if (parsed.success) state.automations.push(parsed.data); else state.kept.push(row);
  }
  return state;
}

export function writeAutomations(state: AutomationState, path = automationsPath()): void {
  const rows = [...state.automations.map(row => Stored.parse(row)), ...state.kept];
  if (rows.length > MAX_ROWS) throw new AutomationStoreError('this computer already keeps the most automations it can');
  writePrivateFile(path, JSON.stringify({ version: VERSION, automations: rows }));
}

/**
 * Reads, changes and saves in one step under the store's lock, so the monitor's runs and a phone's edit
 * in another process never overwrite each other. Saved only when `change` says it changed something.
 */
export function updateAutomations<T>(change: (state: AutomationState) => { changed: boolean; value: T },
  path = automationsPath()): T {
  return withStoreLock(path, () => {
    const state = readAutomations(path), result = change(state);
    if (result.changed) writeAutomations(state, path);
    return result.value;
  });
}

/** The phone's view of a stored automation: no folder, Project or anchor. */
export function wireAutomation(row: StoredAutomation): TaskAutomation {
  return { id: row.id, sessionId: row.sessionId, agent: row.agent, name: row.name, prompt: row.prompt,
    schedule: row.schedule, status: row.status, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(row.nextRunAt === undefined ? {} : { nextRunAt: row.nextRunAt }),
    ...(row.pending ? { waiting: { dueAt: row.pending.dueAt, reason: row.waiting?.reason ?? 'checking',
      ...(row.waiting?.until === undefined ? {} : { until: row.waiting.until }),
      ...(row.pending.manual ? { manual: true } : {}) } } : {}),
    ...(row.last ? { last: row.last } : {}) };
}
