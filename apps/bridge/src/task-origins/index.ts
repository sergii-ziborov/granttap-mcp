import { mkdirSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { UserMessage } from '../../../../packages/protocol/schema';
import { withStoreLock } from '../../../../packages/core/store-file-lock';
import { fingerprint, readOrigin, syncDirectory, writeOrigin } from './storage';
import { configDir } from '../config';
export { resolveTaskOriginJob } from './continuation';
export { decorateTaskOriginCatalog } from './projection';

const Scope = z.object({ room: z.string().min(1).max(180), peerPublicKey: z.string().min(1).max(180),
  originMessageId: z.string().min(1).max(180) }).strict();
export type TaskOriginScope = z.infer<typeof Scope>;
const Record = z.object({ scope: Scope, digest: z.string().length(64),
  agent: z.enum(['codex', 'claude', 'cursor', 'grok']), projectId: z.string().optional(),
  phase: z.enum(['creating', 'ready', 'failed', 'uncertain']),
  owner: z.number().int().positive(), createdAt: z.number().finite(), expiresAt: z.number().finite(),
  lastRetryId: z.string().optional(),
  sessionId: z.string().min(1).max(180).optional() }).strict();
type OriginRecord = z.infer<typeof Record>;
export type OriginResolution = { state: 'started' | 'waiting' | 'ready' | 'failed' | 'uncertain' | 'conflict';
  sessionId?: string; projectId?: string };

/** Only a native creation result can resolve this controller's original message to a chat. */
export class TaskOriginRegistry {
  private readonly catalogCache = new Map<string, { version: string; record: OriginRecord }>();
  private readonly now: () => number;
  private readonly ownerAlive: (pid: number) => boolean;
  constructor(private readonly root: string, options: {
    now?: () => number; ownerAlive?: (pid: number) => boolean;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.ownerAlive = options.ownerAlive ?? (pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    });
  }

  begin(scope: TaskOriginScope, message: UserMessage): OriginResolution {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    syncDirectory(dirname(this.root));
    const { createdAt: _time, retryId: _retry, ...intent } = message;
    const path = this.path(scope), digest = fingerprint(intent);
    return withStoreLock(path, () => {
      const existing = this.read(scope);
      if (existing) {
        if (existing.digest !== digest) return { state: 'conflict' };
        if (existing.phase !== 'failed' || !message.retryId || message.retryId === existing.lastRetryId) {
          return this.resolve(existing, message.agent ?? 'codex', message.projectId);
        }
      }
      const record = Record.parse({ scope, digest, agent: message.agent ?? 'codex',
        projectId: message.projectId, phase: 'creating', owner: process.pid,
        lastRetryId: message.retryId,
        createdAt: this.now(),
        expiresAt: this.now() + 37 * 86_400_000 });
      writeOrigin(path, record);
      return { state: 'started' };
    });
  }

  complete(scope: TaskOriginScope, result: { ok: boolean; sessionId?: string }): void {
    const path = this.path(scope);
    withStoreLock(path, () => {
      const record = this.read(scope);
      if (!record || record.owner !== process.pid) throw new Error('Task origin owner mismatch');
      if (record.phase !== 'creating') return;
      const candidate = result.sessionId?.trim();
      const sessionId = candidate && candidate.length <= 180 ? candidate : undefined;
      const phase = !result.ok ? 'failed' : sessionId ? 'ready' : 'uncertain';
      writeOrigin(path, Record.parse({ ...record, phase, sessionId }));
    });
  }

  /** Only a creation that never reached its native invocation may release its reservation. */
  abandonBeforeStart(scope: TaskOriginScope): void {
    const path = this.path(scope);
    withStoreLock(path, () => {
      const record = this.read(scope);
      if (record?.owner !== process.pid || record.phase !== 'creating') return;
      unlinkSync(path);
      syncDirectory(this.root);
    });
  }

  lookup(scope: TaskOriginScope, agent: string, projectId?: string): OriginResolution {
    const record = this.read(scope);
    return record ? this.resolve(record, agent, projectId) : { state: 'waiting' };
  }

  readyInRoom(room: string) {
    return readdirSync(this.root).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().flatMap(name => {
      try {
        const path = join(this.root, name), stat = statSync(path);
        const version = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        const cached = this.catalogCache.get(path);
        const record = cached?.version === version ? cached.record : Record.parse(readOrigin(path));
        if (this.path(record.scope) !== path) return [];
        this.catalogCache.set(path, { version, record });
        if (record.scope.room !== room || record.phase !== 'ready' || !record.sessionId
            || record.expiresAt <= this.now()) return [];
        return [{ sessionId: record.sessionId, agent: record.agent, projectId: record.projectId,
          originId: record.scope.originMessageId, controllerPublicKey: record.scope.peerPublicKey }];
      } catch { return []; }
    });
  }

  private resolve(record: OriginRecord, agent: string, projectId?: string): OriginResolution {
    if (record.agent !== agent || (projectId !== undefined && projectId !== record.projectId)) {
      return { state: 'conflict' };
    }
    if (record.expiresAt <= this.now()) return { state: 'uncertain' };
    if (record.phase === 'creating') {
      const withinRunLimit = this.now() - record.createdAt <= 6 * 3_600_000 + 60_000;
      return { state: withinRunLimit && this.ownerAlive(record.owner) ? 'waiting' : 'uncertain' };
    }
    if (record.phase !== 'ready' || !record.sessionId) return { state: record.phase === 'failed' ? 'failed' : 'uncertain' };
    return { state: 'ready', sessionId: record.sessionId, projectId: record.projectId };
  }

  private read(scope: TaskOriginScope): OriginRecord | undefined {
    const value = readOrigin(this.path(scope));
    if (value === undefined) return undefined;
    const record = Record.parse(value);
    if (fingerprint(record.scope) !== fingerprint(scope)) throw new Error('Task origin scope mismatch');
    return record;
  }

  private path(scope: TaskOriginScope): string {
    return join(this.root, fingerprint(Scope.parse(scope)) + '.json');
  }
}

let cachedLocal: { root: string; registry: TaskOriginRegistry } | undefined;
export function localTaskOrigins(): TaskOriginRegistry {
  const root = join(configDir(), 'task-origins');
  if (cachedLocal?.root !== root) cachedLocal = { root, registry: new TaskOriginRegistry(root) };
  return cachedLocal.registry;
}
