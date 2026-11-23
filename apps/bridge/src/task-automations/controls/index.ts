import { createHash } from 'node:crypto';
import { TaskAutomationsRequest, TaskAutomationsResult, type CodingAgent, type TaskAutomation }
  from '../../../../../packages/protocol/schema';
import { applyAutomationAction, AutomationRefusal, inScope } from './changes';
import { AutomationStoreError, automationsPath, readAutomations, wireAutomation, type StoredAutomation } from '../store';

/** The chat the phone has open, where new automations go, and its Task's chats on this computer. */
export type AutomationScope = {
  chat: { sessionId: string; agent: CodingAgent; projectId?: string; taskId?: string };
  sessions: readonly string[];
};
type Context = { controller: string; scope: AutomationScope; send: (result: TaskAutomationsResult) => Promise<void> };
export { AutomationRefusal, inScope, LIST_BUDGET_BYTES, MAX_PER_CHAT } from './changes';
type Delivery = { fingerprint: string; result: TaskAutomationsResult; at: number };
const REQUEST_WINDOW_MS = 120_000;

/** The rows one reply carries: oldest first, as many as fit. */
export function listedAutomations(rows: StoredAutomation[]): { automations: TaskAutomation[]; truncated: boolean } {
  const automations = [...rows].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(wireAutomation);
  let truncated = false;
  while (automations.length > 32 || Buffer.byteLength(JSON.stringify(automations)) > 60_000) {
    automations.pop(); truncated = true;
  }
  return { automations, truncated };
}

/**
 * Answers `task.automations` for one paired phone: the Task's automations, after applying the change it
 * asked for. A repeated request id from the same phone gets the first answer again and changes nothing.
 */
export class TaskAutomationControls {
  private readonly deliveries = new Map<string, Delivery>();
  constructor(private readonly options: { now?: () => number; path?: string; changed?: () => void } = {}) {}

  async handle(input: TaskAutomationsRequest, context: Context): Promise<boolean> {
    const now = this.options.now ?? Date.now, parsed = TaskAutomationsRequest.safeParse(input);
    if (!parsed.success || Math.abs(now() - parsed.data.createdAt) > REQUEST_WINDOW_MS) return false;
    const request = parsed.data, at = now();
    for (const [key, value] of this.deliveries) if (at - value.at > REQUEST_WINDOW_MS) this.deliveries.delete(key);
    const key = JSON.stringify([context.controller, request.requestId]);
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.deliveries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return false;
      await context.send(previous.result);
      return true;
    }
    if (this.deliveries.size >= 128) {
      await context.send({ ...this.base(request, at), phase: 'unavailable',
        message: 'Too many automation requests. Wait briefly and refresh status.' });
      return true;
    }
    const result = this.prepare(request, context.scope, at);
    this.deliveries.set(key, { fingerprint, result, at });
    await context.send(result);
    return true;
  }

  private prepare(request: TaskAutomationsRequest, scope: AutomationScope, at: number): TaskAutomationsResult {
    const base = this.base(request, at), path = this.options.path ?? automationsPath();
    try {
      const changedId = request.action ? applyAutomationAction(request.action, scope, at, path) : undefined;
      if (changedId) this.options.changed?.();
      const { automations, truncated } = listedAutomations(readAutomations(path).automations.filter(inScope(scope)));
      return TaskAutomationsResult.parse({ ...base, automations, ...(truncated ? { truncated } : {}),
        ...(changedId ? { changedId } : {}), phase: 'completed' });
    } catch (error) {
      // Store and parser errors can name private paths. Only owned sentences reach the phone.
      const message = error instanceof AutomationRefusal ? error.message
        : error instanceof AutomationStoreError ? 'The saved automations on this computer cannot be read. Nothing was changed.'
          : 'The computer could not apply this change. Refresh before retrying.';
      return { ...base, phase: 'failed', message };
    }
  }

  private base(request: TaskAutomationsRequest, at: number) {
    return { type: 'task.automations.result' as const, requestId: request.requestId, sessionId: request.sessionId,
      automations: [], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, createdAt: at };
  }
}
