import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { withStoreLock } from '../../../../packages/core/store-file-lock';
import { configDir, writePrivateFile } from '../config';

const Receipt = z.object({ digest: z.string().length(64), phase: z.enum(['sending', 'accepted']),
  turnId: z.string().min(1).max(180).optional() }).strict();
type Record = z.infer<typeof Receipt>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** A crashed or disconnected submission is never replayed as a new native turn. */
export class DesktopReceipt {
  private readonly path: string;
  private readonly digest: string;

  constructor(threadId: string, messageId: string, intent: unknown) {
    this.path = join(configDir(), 'codex-desktop-deliveries', hash(`${threadId}:${messageId}`) + '.json');
    this.digest = hash(JSON.stringify(intent));
  }

  begin(): 'new' | 'accepted' | 'uncertain' | 'conflict' {
    return withStoreLock(this.path, () => {
      const prior = this.lookup();
      if (prior) return prior;
      this.save({ digest: this.digest, phase: 'sending' });
      return 'new';
    });
  }

  lookup(): 'accepted' | 'uncertain' | 'conflict' | undefined {
    if (!existsSync(this.path)) return undefined;
    const prior = this.read();
    if (prior.digest !== this.digest) return 'conflict';
    return prior.phase === 'accepted' ? 'accepted' : 'uncertain';
  }

  accept(turnId: string): void {
    withStoreLock(this.path, () => {
      const prior = this.read();
      if (prior.digest !== this.digest) throw new Error('Codex delivery identity changed.');
      this.save({ ...prior, phase: 'accepted', turnId });
    });
  }

  private read(): Record { return Receipt.parse(JSON.parse(readFileSync(this.path, 'utf8'))); }
  private save(record: Record): void {
    writePrivateFile(this.path, JSON.stringify(record) + '\n');
    for (const path of [this.path, ...(process.platform === 'win32' ? [] : [dirname(this.path)])]) {
      const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
}
