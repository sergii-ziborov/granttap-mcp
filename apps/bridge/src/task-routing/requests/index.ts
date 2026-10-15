import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { withStoreLock } from '../../../../../packages/core/store-file-lock';
import { writePrivateFile } from '../../config/access/write-private';
import { configDir } from '../../config/runtime/paths';
import { TaskRoutingNeeds } from '../../../../../packages/protocol/task-resources';

export const RoutingRequirementsInput = TaskRoutingNeeds.extend({ reason: z.enum(['capacity', 'required_hardware']),
  portable: TaskRoutingNeeds.shape.portable.default(false),
  minAvailableMemoryBytes: TaskRoutingNeeds.shape.minAvailableMemoryBytes.default(2 * 2 ** 30),
  minAvailableDiskBytes: TaskRoutingNeeds.shape.minAvailableDiskBytes.default(2 ** 30),
  requiredTools: TaskRoutingNeeds.shape.requiredTools.default(['git']) }).strict();
const Source = z.object({ sessionId: z.string().min(1).max(256), projectId: z.string().min(1).max(128),
  nativeSessionId: z.string().min(1).max(256).optional(),
  taskId: z.string().min(1).max(128), provider: z.enum(['claude', 'codex', 'cursor', 'grok']),
  model: z.string().min(1).max(200), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional() }).strict();
const Row = z.object({ id: z.string().uuid(), operation: z.string().min(1).max(128), source: Source,
  requirements: RoutingRequirementsInput, createdAt: z.number(), expiresAt: z.number(),
  phase: z.enum(['awaiting_idle', 'preparing', 'submitted', 'failed']), owner: z.string().optional(),
  nextAttemptAt: z.number().optional(),
  code: z.string().max(80).optional(), updatedAt: z.number() }).strict();
export type RoutingRequest = z.infer<typeof Row>;
export type RoutingRequestSource = z.infer<typeof Source>;
const active = (row: RoutingRequest) => ['awaiting_idle', 'preparing'].includes(row.phase);

/** Durable source intent; it starts no provider and carries no transcript or credentials. */
export class RoutingRequests {
  private readonly path: string;
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.path = join(root, 'requests.json');
  }

  request(operation: string, input: RoutingRequestSource, requirements: z.input<typeof RoutingRequirementsInput>,
    now = Date.now()): RoutingRequest {
    const row = Row.parse({ id: randomUUID(), operation, source: input, requirements,
      createdAt: now, updatedAt: now, expiresAt: now + 10 * 60_000, phase: 'awaiting_idle' });
    return this.update(rows => {
      const previous = rows.find(item => item.operation === operation && item.source.sessionId === row.source.sessionId);
      if (previous) {
        if (digest([previous.source, previous.requirements]) !== digest([row.source, row.requirements])) {
          throw new Error('This routing operation already names different work.');
        }
        return previous;
      }
      if (rows.some(item => active(item) && item.source.sessionId === row.source.sessionId)) {
        throw new Error('This chat already has a pending computer transfer.');
      }
      for (let index = rows.length - 1; index >= 0; index--) {
        if (!active(rows[index]!) && rows[index]!.updatedAt < now - 7 * 86_400_000) rows.splice(index, 1);
      }
      if (rows.length >= 128) throw new Error('The retained routing request capacity is full.');
      rows.push(row); return row;
    });
  }

  get(id: string): RoutingRequest | undefined { return this.read().find(row => row.id === id); }
  latest(sessionId: string): RoutingRequest | undefined {
    return this.read().filter(row => this.matches(row, sessionId)).sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  pending(): RoutingRequest[] { return this.read().filter(active); }
  blockReason(sessionId: string | undefined, toolName?: string, now = Date.now()): string | undefined {
    if (!sessionId || toolName?.split('__').at(-1) === 'offload_task') return undefined;
    return this.read().some(row => active(row) && this.matches(row, sessionId) && row.expiresAt > now)
      ? 'Finish the current reply: this chat is preparing an automatic computer transfer. New tools are paused until it finishes.' : undefined;
  }

  cancel(sessionId: string, now = Date.now()): boolean {
    return this.update(rows => {
      const row = rows.find(row => this.matches(row, sessionId) && row.phase === 'awaiting_idle');
      if (!row) return false;
      Object.assign(row, { phase: 'failed', code: 'cancelled', updatedAt: now }); return true;
    });
  }

  begin(id: string, owner: string, now: number): boolean {
    return this.update(rows => {
      const row = rows.find(row => row.id === id);
      if (row?.phase !== 'awaiting_idle' || row.expiresAt <= now) return false;
      Object.assign(row, { phase: 'preparing', owner, updatedAt: now }); return true;
    });
  }

  wait(id: string, owner: string, now: number): void {
    this.update(rows => {
      const row = rows.find(row => row.id === id);
      if (row?.phase !== 'preparing' || row.owner !== owner) return;
      row.phase = 'awaiting_idle'; row.updatedAt = now; row.nextAttemptAt = now + 30_000;
      delete row.owner;
    });
  }

  finish(id: string, phase: 'submitted' | 'failed', code: string, now: number, owner?: string): void {
    this.update(rows => {
      const row = rows.find(row => row.id === id);
      if (!row || !active(row) || owner && row.owner !== owner) return;
      Object.assign(row, { phase, code, updatedAt: now });
    });
  }

  private read(): RoutingRequest[] {
    if (!existsSync(this.path)) return [];
    if (statSync(this.path).size > 512_000) throw new Error('The routing request journal exceeds its bound.');
    return z.array(Row).max(128).parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }
  private matches(row: RoutingRequest, sessionId: string): boolean {
    return row.source.sessionId === sessionId || row.source.nativeSessionId === sessionId;
  }
  private update<T>(work: (rows: RoutingRequest[]) => T): T {
    return withStoreLock(this.path, () => {
      const rows = this.read(), value = work(rows);
      writePrivateFile(this.path, JSON.stringify(rows));
      for (const path of process.platform === 'win32' ? [this.path] : [this.path, this.root]) {
        const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      return value;
    });
  }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const localRoutingRequests = () => new RoutingRequests(join(configDir(), 'task-routing'));
