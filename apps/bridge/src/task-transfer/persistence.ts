import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config/runtime/paths';
import { writePrivateFile } from '../config/access/write-private';
import { withStoreLock } from '../../../../packages/core/store-file-lock';
import { materializeTransferContext } from './context/materialize';
import { PreparedTransfer, type TransferPreparation } from './records';

export const transferDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const MAX_TRANSFER_CONTEXT_BYTES = 16_000_000;

export class TransferPersistence {
  private recordCache?: { modified: number; changed: number; rows: PreparedTransfer[] };
  constructor(protected readonly directory = join(configDir(), 'task-transfers')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  protected load(id: string): PreparedTransfer | undefined {
    const path = this.recordPath(id);
    if (!existsSync(path)) return undefined;
    if (statSync(path).size > 200_000) throw new Error('Transfer record exceeds its bound.');
    return PreparedTransfer.parse(JSON.parse(readFileSync(path, 'utf8')));
  }

  protected records(): PreparedTransfer[] {
    const stat = statSync(this.directory);
    if (this.recordCache?.modified === stat.mtimeMs && this.recordCache.changed === stat.ctimeMs) return this.recordCache.rows;
    const rows = readdirSync(this.directory).flatMap(name => {
      if (!/^transfer-[a-f0-9]{48}\.json$/.test(name)) return [];
      const row = this.load(name.slice(0, -5));
      return row ? [row] : [];
    });
    this.recordCache = { modified: stat.mtimeMs, changed: stat.ctimeMs, rows };
    return rows;
  }

  prepare(input: TransferPreparation): PreparedTransfer {
    if (Buffer.byteLength(input.context) > MAX_TRANSFER_CONTEXT_BYTES) {
      throw new Error('The full transfer context is too large. No partial transfer was prepared.');
    }
    const sessionId = `transfer-${transferDigest(input.eventId).slice(0, 48)}`;
    const contextHash = transferDigest(input.context);
    const { context, ...metadata } = input;
    const candidate = PreparedTransfer.parse({ ...metadata, version: 1, sessionId,
      contextHash, phase: 'prepared', updatedAt: input.acceptedAt });
    return withStoreLock(this.recordPath(sessionId), () => {
      const saved = this.load(sessionId);
      if (saved) {
        if (saved.contextHash !== contextHash || saved.projectId !== input.projectId
          || saved.capsule.taskId !== input.capsule.taskId || saved.sourceSessionId !== input.sourceSessionId
          || saved.workspace !== input.workspace || saved.capsule.targetProvider !== input.capsule.targetProvider) {
          throw new Error('This transfer id already names different work.');
        }
        this.readContext(saved); return saved;
      }
      materializeTransferContext(context, this.directory, sessionId);
      this.writeDurable(this.contextPath(sessionId)!, context);
      this.writeDurable(this.recordPath(sessionId), JSON.stringify(candidate));
      return candidate;
    });
  }

  forEvent(eventId: string): PreparedTransfer | undefined {
    return this.load(`transfer-${transferDigest(eventId).slice(0, 48)}`);
  }

  contextPath(id: string): string | undefined {
    return /^transfer-[a-f0-9]{48}$/.test(id) ? join(this.directory, `${id}.context.txt`) : undefined;
  }

  providerContextPath(id: string): string {
    const record = this.load(id);
    if (!record) throw new Error('The transfer context is unavailable.');
    return materializeTransferContext(this.readContext(record), this.directory, id);
  }

  protected readContext(record: PreparedTransfer): string {
    const path = this.contextPath(record.sessionId)!;
    if (statSync(path).size > MAX_TRANSFER_CONTEXT_BYTES) throw new Error('Transfer context exceeds its bound.');
    const value = readFileSync(path, 'utf8');
    if (transferDigest(value) !== record.contextHash) throw new Error('The transfer context is incomplete.');
    return value;
  }

  protected update(id: string, update: (value: PreparedTransfer) => PreparedTransfer): PreparedTransfer {
    return withStoreLock(this.recordPath(id), () => {
      const record = this.load(id);
      if (!record) throw new Error('The prepared transfer no longer exists.');
      const next = PreparedTransfer.parse(update(record));
      this.writeDurable(this.recordPath(id), JSON.stringify(next)); return next;
    });
  }

  private writeDurable(path: string, data: string): void {
    writePrivateFile(path, data);
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (process.platform !== 'win32') {
      const parent = openSync(this.directory, 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  }

  private recordPath(id: string): string {
    if (!/^transfer-[a-f0-9]{48}$/.test(id)) throw new Error('Invalid prepared transfer identity.');
    return join(this.directory, `${id}.json`);
  }
}
