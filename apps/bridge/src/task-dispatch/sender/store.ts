import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { withStoreLock } from '../../../../../packages/core/store-file-lock';
import { Envelope, CodingAgent } from '../../../../../packages/protocol/schema';
import { digest, readRequest, syncDirectory, writeRequest } from '../journal';

export const NativeQueueScope = z.object({ projectId: z.string().min(1).max(180),
  taskId: z.string().min(1).max(180), sessionId: z.string().min(1).max(180), provider: CodingAgent }).strict();
export type NativeQueueScope = z.infer<typeof NativeQueueScope>;
const Header = z.object({ id: z.string(), scope: NativeQueueScope, intent: z.string(),
  createdAt: z.number().int(), notBefore: z.number().int(), expiresAt: z.number().int() }).strict();
export type Header = z.infer<typeof Header>;
const Record = z.object({ header: Header, body: z.object({ notBefore: z.number().int(), expiresAt: z.number().int(),
  acceptanceHash: z.string(), envelope: Envelope }).strict() }).strict();
export type SenderRecord = z.infer<typeof Record>;

/** Scope metadata stays small; background retries load only unconfirmed encrypted bodies. */
export class NativeTaskQueueStore {
  private readonly directory: string;
  constructor(root: string, config: PeerConfig) {
    this.directory = join(root, digest(config.room));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); syncDirectory(root); syncDirectory(dirname(root));
  }

  stage(header: Header, create: () => SenderRecord): Header {
    header = Header.parse(header);
    const paths = this.paths(header.id);
    return withStoreLock(paths.intent, () => {
      if (existsSync(paths.intent)) {
        const saved = Header.parse(readRequest(paths.intent));
        if (digest(saved) !== digest(header)) throw new Error('Queued operation identity already exists.');
        syncDirectory(paths.directory);
        return saved;
      }
      const pending = this.pending();
      const bytes = pending.reduce((sum, id) => sum + statSync(this.paths(id).body).size, 0);
      if (pending.length >= 100 || bytes >= 48_000_000) throw new Error('Local relay upload capacity reached.');
      const record = Record.parse(existsSync(paths.body) ? readRequest(paths.body) : create());
      if (bytes + Buffer.byteLength(JSON.stringify(record)) > 48_000_000) throw new Error('Local relay upload capacity reached.');
      if (digest(record.header) !== digest(header)) throw new Error('Queued operation identity already exists.');
      if (!existsSync(paths.body)) writeRequest(paths.body, record);
      writeRequest(paths.intent, header);
      return header;
    });
  }

  header(id: string, scope?: NativeQueueScope): Header {
    const header = Header.parse(readRequest(this.paths(id).intent));
    if (header.id !== id || scope && digest(header.scope) !== digest(NativeQueueScope.parse(scope))) throw new Error('Queued Task scope mismatch.');
    return header;
  }

  record(id: string): SenderRecord {
    const record = Record.parse(readRequest(this.paths(id).body));
    if (record.header.id !== id) throw new Error('Queued operation identity mismatch.');
    return record;
  }

  uploaded(id: string): boolean { return existsSync(this.paths(id).receipt); }

  confirm(id: string): void {
    const paths = this.paths(id);
    withStoreLock(paths.intent, () => {
      if (!existsSync(paths.receipt)) writeRequest(paths.receipt, { id, confirmedAt: Date.now() });
    });
  }

  retire(id: string): void {
    const paths = this.paths(id);
    if (existsSync(paths.body)) { unlinkSync(paths.body); syncDirectory(paths.directory); }
  }

  pending(): string[] {
    return readdirSync(this.directory, { withFileTypes: true }).filter(entry => entry.isDirectory()
      && /^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(entry.name)).flatMap(entry => {
        const paths = this.paths(entry.name);
        if (!existsSync(paths.intent) || existsSync(paths.receipt)) return [];
        try { return [this.header(entry.name)]; } catch { return []; }
      }).sort((a, b) => a.notBefore - b.notBefore || a.createdAt - b.createdAt).map(row => row.id);
  }

  private paths(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(id)) throw new Error('Invalid queued operation identity.');
    const directory = join(this.directory, id);
    if (!existsSync(directory)) { mkdirSync(directory, { mode: 0o700 }); syncDirectory(this.directory); }
    return { directory, intent: join(directory, 'intent.json'), body: join(directory, 'body.json'),
      receipt: join(directory, 'receipt.json') };
  }
}
