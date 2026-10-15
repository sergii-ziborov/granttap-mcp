import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Envelope } from '../../../../../packages/protocol/schema';
import { PeerTaskDispatch, PeerTaskResult } from '../../../../../packages/protocol/task-network';
import { withStoreLock } from '../../../../../packages/core/store-file-lock';
import { networkDigest, networkJobId, readNetworkFile, writeNetworkFile } from './private-file';

const Record = z.object({ job: PeerTaskDispatch, peerPublicKey: z.string(), writerId: z.string() }).strict();
const Header = z.object({ id: z.string(), projectId: z.string(), taskId: z.string(), fingerprint: z.string(),
  peerPublicKey: z.string(), writerId: z.string(), expiresAt: z.number(), claimId: z.string(),
  phase: z.enum(['staged', 'preparing', 'result', 'completed', 'expired']),
  owner: z.string().optional(), updatedAt: z.number(),
  preparationStarted: z.boolean().optional(),
}).strict();
export type IncomingPeerTransfer = z.infer<typeof Header>;
const Result = z.object({ envelope: Envelope, accepted: z.boolean(), code: z.string().max(80).optional(),
  body: PeerTaskResult.optional() }).strict();

/** Receiver fsync precedes a claim; only idempotent preparation may recover an interrupted attempt. */
export class PeerTransferInbox {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }

  stage(job: z.infer<typeof PeerTaskDispatch>, peerPublicKey: string, writerId: string): IncomingPeerTransfer {
    const value = Record.parse({ job, peerPublicKey, writerId }), fingerprint = networkDigest(value);
    const path = this.path(job.jobId, 'header');
    return withStoreLock(join(this.directory, '.admission'), () => withStoreLock(path, () => {
      if (existsSync(path)) {
        const saved = this.header(job.jobId);
        if (saved.fingerprint !== fingerprint) throw new Error('Peer transfer identity conflict.');
        return saved;
      }
      const active = this.pending();
      const bytes = active.reduce((sum, row) => sum + statSync(this.path(row.id, 'request')).size, 0);
      if (active.length >= 100 || bytes + Buffer.byteLength(JSON.stringify(value)) > 48_000_000) {
        throw new Error('Peer transfer receiver capacity reached.');
      }
      writeNetworkFile(this.path(job.jobId, 'request'), value);
      const header: IncomingPeerTransfer = { id: job.jobId, projectId: job.operation.projectId,
        taskId: job.operation.taskId, fingerprint, peerPublicKey, writerId, expiresAt: job.expiresAt,
        claimId: randomUUID(), phase: 'staged', updatedAt: Date.now() };
      writeNetworkFile(path, header); return header;
    }));
  }

  header(id: string): IncomingPeerTransfer { return Header.parse(readNetworkFile(this.path(id, 'header'), 16_000)); }
  record(id: string) { return Record.parse(readNetworkFile(this.path(id, 'request'))); }
  result(id: string) { return Result.parse(readNetworkFile(this.path(id, 'result'), 40_000)); }

  acquire(id: string, owner: string): boolean {
    return withStoreLock(this.path(id, 'header'), () => {
      const header = this.header(id);
      if (!['staged', 'preparing'].includes(header.phase)) return false;
      if (header.phase === 'preparing' && header.owner !== owner && ownerAlive(header)) return false;
      writeNetworkFile(this.path(id, 'header'), { ...header, phase: 'preparing', owner, updatedAt: Date.now() });
      return true;
    });
  }

  saveResult(id: string, owner: string, result: z.infer<typeof Result>): void {
    withStoreLock(this.path(id, 'header'), () => {
      const header = this.header(id);
      if (header.phase !== 'preparing' || header.owner !== owner) throw new Error('Peer transfer preparation owner changed.');
      writeNetworkFile(this.path(id, 'result'), Result.parse(result));
      writeNetworkFile(this.path(id, 'header'), { ...header, phase: 'result', updatedAt: Date.now() });
    });
  }

  beginPreparation(id: string, owner: string): void {
    withStoreLock(this.path(id, 'header'), () => {
      const header = this.header(id);
      if (header.phase !== 'preparing' || header.owner !== owner) throw new Error('Transfer preparation owner changed.');
      writeNetworkFile(this.path(id, 'header'), { ...header, preparationStarted: true, updatedAt: Date.now() });
    });
  }

  complete(id: string): void {
    withStoreLock(this.path(id, 'header'), () => {
      const header = this.header(id);
      if (header.phase !== 'result' && header.phase !== 'completed') throw new Error('A peer transfer has no durable outcome.');
      writeNetworkFile(this.path(id, 'header'), { ...header, phase: 'completed', owner: undefined, updatedAt: Date.now() });
      const request = this.path(id, 'request');
      if (existsSync(request)) unlinkSync(request);
    });
  }

  refreshResult(id: string, envelope: z.infer<typeof Envelope>): void {
    withStoreLock(this.path(id, 'header'), () => {
      if (this.header(id).phase !== 'result') throw new Error('Transfer result is not awaiting confirmation.');
      writeNetworkFile(this.path(id, 'result'), { ...this.result(id), envelope });
    });
  }

  pending(): IncomingPeerTransfer[] {
    return readdirSync(this.directory).filter(name => name.endsWith('.header.json')).flatMap(name => {
      const header = this.header(name.slice(0, -'.header.json'.length));
      return ['completed', 'expired'].includes(header.phase) ? [] : [header];
    });
  }

  private path(id: string, kind: string): string { return join(this.directory, `${networkJobId(id)}.${kind}.json`); }
}

function ownerAlive(record: IncomingPeerTransfer): boolean {
  const pid = Number(record.owner?.split(':')[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || Date.now() - record.updatedAt > 15 * 60_000) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
