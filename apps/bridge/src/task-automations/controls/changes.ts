import { randomBytes } from 'node:crypto';
import { TaskAutomationAction, type AutomationDraft } from '../../../../../packages/protocol/schema';
import { nextOccurrence, scheduleProblem } from '../cadence';
import { updateAutomations, wireAutomation, type AutomationState, type StoredAutomation } from '../store';
import type { AutomationScope } from '.';

/** A change refused for a reason the phone shows as it is. */
export class AutomationRefusal extends Error {}

export const MAX_PER_CHAT = 16;
/** A Task's listed rows must fit one reply with room left for each one's run state. */
export const LIST_BUDGET_BYTES = 56_000;
const MAX_ROWS = 256;

function refuse(message: string): never { throw new AutomationRefusal(message); }

function checkDraft(draft: AutomationDraft, at: number): void {
  const problem = scheduleProblem(draft.schedule, at);
  if (problem) refuse(problem);
}

const sameSchedule = (row: StoredAutomation, draft: AutomationDraft) => JSON.stringify(row.schedule) === JSON.stringify(draft.schedule);

/** The automations a chat lists: those of its Task's chats here, and those kept for its Task. */
export function inScope(scope: AutomationScope): (row: StoredAutomation) => boolean {
  const { projectId, taskId } = scope.chat;
  return row => scope.sessions.includes(row.sessionId)
    || projectId !== undefined && taskId !== undefined && row.projectId === projectId && row.taskId === taskId;
}

/** The Task's rows, with `row` in place of the one it replaces, fit one reply. */
function checkFits(state: AutomationState, listed: (row: StoredAutomation) => boolean, row: StoredAutomation): void {
  const rows = [...state.automations.filter(item => item.id !== row.id && listed(item)), row].map(wireAutomation);
  if (Buffer.byteLength(JSON.stringify(rows)) > LIST_BUDGET_BYTES) {
    refuse("This Task's automations are too long to list together. Shorten a message or delete an automation.");
  }
}

function created(draft: AutomationDraft, scope: AutomationScope, at: number): StoredAutomation {
  const next = nextOccurrence(draft.schedule, at, at);
  const { sessionId, agent, projectId, taskId } = scope.chat;
  return { id: `gta-${randomBytes(8).toString('hex')}`, sessionId, agent,
    ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}),
    name: draft.name, prompt: draft.prompt, schedule: draft.schedule, status: 'ACTIVE', revision: 1,
    createdAt: at, updatedAt: at, anchorAt: at, ...(next === undefined ? {} : { nextRunAt: next }) };
}

function edited(row: StoredAutomation, draft: AutomationDraft, at: number): void {
  const rescheduled = !sameSchedule(row, draft);
  Object.assign(row, { name: draft.name, prompt: draft.prompt, schedule: draft.schedule });
  if (!rescheduled) return;
  // A new schedule counts from now and drops a run the old one had waiting; a Run now still goes.
  row.anchorAt = at;
  if (row.pending && !row.pending.manual) { delete row.pending; delete row.waiting; }
  const next = row.status === 'ACTIVE' ? nextOccurrence(row.schedule, at, at) : undefined;
  if (next === undefined) delete row.nextRunAt; else row.nextRunAt = next;
}

function resumed(row: StoredAutomation, at: number): void {
  const next = nextOccurrence(row.schedule, at, at);
  if (next === undefined) refuse('Choose a time in the future to run it again.');
  Object.assign(row, { status: 'ACTIVE', anchorAt: at, nextRunAt: next });
}

function paused(row: StoredAutomation): void {
  row.status = 'PAUSED';
  delete row.nextRunAt; delete row.pending; delete row.waiting;
}

/** Applies one change to the Task's automations and returns the id it changed. Refusals change nothing. */
export function applyAutomationAction(input: unknown, scope: AutomationScope, at: number, path: string): string {
  const parsed = TaskAutomationAction.safeParse(input);
  if (!parsed.success) refuse('Update GrantTap MCP on this computer to use this automation change.');
  const action = parsed.data, listed = inScope(scope);
  return updateAutomations(state => {
    if (action.kind === 'create') {
      checkDraft(action.draft, at);
      if (state.automations.filter(row => row.sessionId === scope.chat.sessionId).length >= MAX_PER_CHAT) {
        refuse('This chat already has the most automations it can keep.');
      }
      if (state.automations.length + state.kept.length >= MAX_ROWS) refuse('This computer already keeps the most automations it can.');
      const row = created(action.draft, scope, at);
      checkFits(state, listed, row);
      state.automations.push(row);
      return { changed: true, value: row.id };
    }
    const index = state.automations.findIndex(row => row.id === action.id && listed(row));
    const row = state.automations[index];
    if (!row) return refuse('This automation is no longer on this computer. Refresh to see the current list.');
    if (action.kind === 'run') {
      row.pending = row.pending ? { ...row.pending, manual: true } : { dueAt: at, since: at, manual: true };
      return { changed: true, value: row.id };
    }
    if (action.revision !== row.revision) refuse('This automation changed. Refresh before editing it.');
    if (action.kind === 'delete') {
      state.automations.splice(index, 1);
      return { changed: true, value: row.id };
    }
    if (action.kind === 'update') {
      // Renaming a one-time automation that already ran keeps its time; a new time must be ahead.
      if (!sameSchedule(row, action.draft)) checkDraft(action.draft, at);
      edited(row, action.draft, at);
      checkFits(state, listed, row);
    }
    else if (action.kind === 'pause') paused(row);
    else resumed(row, at);
    Object.assign(row, { revision: row.revision + 1, updatedAt: Math.max(at, row.updatedAt) });
    return { changed: true, value: row.id };
  }, path);
}
