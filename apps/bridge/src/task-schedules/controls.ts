import { createHash } from 'node:crypto';
import { TaskSchedulesRequest, TaskSchedulesResult } from '../../../../packages/protocol/task-schedules';
import type { createTaskScheduleRepository } from '.';

type Repository = ReturnType<typeof createTaskScheduleRepository>;
type Delivery = { fingerprint: string; result: TaskSchedulesResult; at: number };
type Context = { controller: string; sessions: readonly string[]; send: (result: TaskSchedulesResult) => Promise<void> };

/** Edits are addressed to an existing native automation and idempotent per paired controller. */
export class TaskScheduleControls {
  private readonly deliveries = new Map<string, Delivery>();
  constructor(private readonly repository: Repository, private readonly now: () => number = Date.now) {}

  async handle(input: TaskSchedulesRequest, context: Context): Promise<boolean> {
    const parsed = TaskSchedulesRequest.safeParse(input);
    if (!parsed.success || Math.abs(this.now() - parsed.data.createdAt) > 120_000) return false;
    const request = parsed.data, at = this.now();
    for (const [key, value] of this.deliveries) if (at - value.at > 120_000) this.deliveries.delete(key);
    const key = JSON.stringify([context.controller, request.requestId]);
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.deliveries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return false;
      await context.send(previous.result); return true;
    }
    if (this.deliveries.size >= 128) {
      await context.send({ ...this.base(request, at), phase: 'unavailable',
        message: 'Too many automation requests. Wait briefly and refresh status.' });
      return true;
    }
    const result = this.prepare(request, context.sessions, at);
    this.deliveries.set(key, { fingerprint, result, at });
    await context.send(result);
    return true;
  }

  private prepare(request: TaskSchedulesRequest, sessions: readonly string[], at: number): TaskSchedulesResult {
    const base = this.base(request, at);
    if (sessions.length === 0) return { ...base, phase: 'unavailable',
      message: 'Codex automations are unavailable for this chat on this computer.' };
    try {
      const change = request.change;
      const updated = change ? this.repository.change(change.id, change.revision, change.patch, sessions) : undefined;
      const list = this.repository.list(sessions);
      const schedules = updated ? [updated, ...list.schedules.filter(row => row.id !== updated.id)] : [...list.schedules];
      let truncated = list.truncated;
      while (schedules.length > 32 || Buffer.byteLength(JSON.stringify(schedules)) > 60_000) { schedules.pop(); truncated = true; }
      return TaskSchedulesResult.parse({ ...base, schedules, truncated,
        phase: updated && updated.confirmation !== 'confirmed' ? 'waiting' : 'completed' });
    } catch (error) {
      // Parser and native-storage errors can contain private configuration. Return only owned messages.
      const message = error instanceof Error && /^(This automation |Choose a supported schedule\.|The native scheduler is unavailable\.|The computer clock is unavailable\.)/.test(error.message)
        ? error.message.slice(0, 240) : 'The computer could not apply this change. Refresh before retrying.';
      return { ...base, phase: 'failed', message };
    }
  }

  private base(request: TaskSchedulesRequest, at: number) {
    return { type: 'task.schedules.result' as const, requestId: request.requestId,
      sessionId: request.sessionId, schedules: [], truncated: false,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, createdAt: at };
  }
}
