import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { withStoreLock } from '../../../../../packages/core/store-file-lock';
import { InboxState } from '../records';
import { readRequest, syncDirectory, writeRequest } from '../journal';

const Receipt = z.object({ room: z.string(), jobId: z.string(), jobDigest: z.string(), peerPublicKey: z.string(),
  retainUntil: z.number().int(), state: InboxState }).strict();
export type ReceiverReceipt = z.infer<typeof Receipt>;

/** Terminal replay protection does not need the user's prompt or photo bytes. */
export class TaskDispatchReceipts {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); syncDirectory(dirname(directory));
  }

  read(id: string): ReceiverReceipt | undefined {
    const path = this.path(id);
    return existsSync(path) ? Receipt.parse(readRequest(path)) : undefined;
  }

  write(input: ReceiverReceipt): void {
    const receipt = Receipt.parse(input), path = this.path(receipt.jobId);
    withStoreLock(path, () => {
      const saved = this.read(receipt.jobId);
      if (saved) {
        if (saved.jobDigest !== receipt.jobDigest || saved.peerPublicKey !== receipt.peerPublicKey
          || saved.room !== receipt.room) throw new Error('Task receipt scope mismatch.');
        return;
      }
      writeRequest(path, receipt);
    });
  }

  async purge(now: number): Promise<void> {
    let visited = 0;
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5), path = this.path(id);
      withStoreLock(path, () => {
        const receipt = this.read(id);
        if (receipt && now > receipt.retainUntil) { unlinkSync(path); syncDirectory(this.directory); }
      });
      if (++visited % 64 === 0) await setImmediate();
    }
  }

  private path(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(id)) throw new Error('Invalid task receipt identity.');
    return join(this.directory, `${id}.json`);
  }
}
