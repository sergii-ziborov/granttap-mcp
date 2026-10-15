import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { withStoreLock } from '../../../../../packages/core/store-file-lock';
import { Envelope, TaskCapsule } from '../../../../../packages/protocol/schema';
import { TaskNetworkPeer } from '../../../../../packages/protocol/task-network';
import { networkDigest, networkJobId, readNetworkFile, writeNetworkFile } from './private-file';

const Header = z.object({ id: z.string(), projectId: z.string(), taskId: z.string(), eventId: z.string(),
  sourceSessionId: z.string().min(1).max(256), capsule: TaskCapsule,
  peer: TaskNetworkPeer,
  automatic: z.literal(true).optional(),
  targetEndpointId: z.string(), writerId: z.string(), revision: z.number().int(), intent: z.string(),
  createdAt: z.number(), expiresAt: z.number(), state: z.enum(['drafting', 'uploading', 'queued', 'accepted', 'completed', 'failed']),
}).strict();
export type OutgoingPeerTransfer = z.infer<typeof Header>;
const Body = z.object({ notBefore: z.number(), expiresAt: z.number(), acceptanceHash: z.string(), envelope: Envelope }).strict();

/** Immutable ciphertext survives the originating CLI and phone closing. */
export class PeerTransferOutbox {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }

  stage(input: Omit<OutgoingPeerTransfer, 'state' | 'intent'>, intent: unknown,
    create: () => z.infer<typeof Body>): OutgoingPeerTransfer {
    const path = this.path(input.id, 'header');
    const header = Header.parse({ ...input, intent: networkDigest(intent), state: 'drafting' });
    return withStoreLock(join(this.directory, '.admission'), () => withStoreLock(path, () => {
      if (existsSync(path)) {
        const previous = this.header(input.id);
        if (networkDigest({ ...previous, state: 'drafting' }) !== networkDigest(header)) {
          throw new Error('Transfer identity already names different work.');
        }
        return previous;
      }
      const active = this.pending();
      if (active.some(row => row.sourceSessionId === header.sourceSessionId)) {
        throw new Error('This source already has a pending transfer. Wait for confirmation before moving it again.');
      }
      const bytes = active.reduce((sum, row) => sum + (existsSync(this.path(row.id, 'cipher')) ? statSync(this.path(row.id, 'cipher')).size : 0), 0);
      if (active.length >= 100 || bytes >= 48_000_000) throw new Error('Project transfer upload capacity reached.');
      const body = Body.parse(create());
      if (bytes + Buffer.byteLength(JSON.stringify(body)) > 48_000_000) throw new Error('Project transfer upload capacity reached.');
      writeNetworkFile(this.path(input.id, 'cipher'), body);
      writeNetworkFile(path, header);
      return header;
    }));
  }

  header(id: string): OutgoingPeerTransfer { return Header.parse(readNetworkFile(this.path(id, 'header'), 256_000)); }
  body(id: string) { return Body.parse(readNetworkFile(this.path(id, 'cipher'))); }

  activate(id: string): OutgoingPeerTransfer {
    const path = this.path(id, 'header');
    return withStoreLock(path, () => {
      const header = this.header(id);
      if (header.state !== 'drafting') return header;
      const active = Header.parse({ ...header, state: 'uploading' });
      writeNetworkFile(path, active); return active;
    });
  }

  /** An abandoned capture can be discarded only while upload has never been admitted. */
  discardDraft(id: string): boolean {
    const path = this.path(id, 'header');
    return withStoreLock(path, () => {
      const header = this.header(id);
      if (header.state !== 'drafting') return false;
      writeNetworkFile(path, { ...header, state: 'failed' });
      const cipher = this.path(id, 'cipher');
      if (existsSync(cipher)) unlinkSync(cipher);
      return true;
    });
  }

  state(id: string, state: OutgoingPeerTransfer['state']): void {
    const path = this.path(id, 'header');
    withStoreLock(path, () => {
      const header = this.header(id);
      if (header.state === state) return;
      if (header.state === 'completed' || header.state === 'failed') return;
      writeNetworkFile(path, { ...header, state });
      if (state === 'completed' || state === 'failed') {
        const cipher = this.path(id, 'cipher');
        if (existsSync(cipher)) unlinkSync(cipher);
      }
    });
  }

  pending(): OutgoingPeerTransfer[] {
    return readdirSync(this.directory).filter(name => name.endsWith('.header.json')).flatMap(name => {
      const header = this.header(name.slice(0, -'.header.json'.length));
      return ['completed', 'failed'].includes(header.state) ? [] : [header];
    }).sort((a, b) => a.createdAt - b.createdAt);
  }

  private path(id: string, kind: string): string { return join(this.directory, `${networkJobId(id)}.${kind}.json`); }
}
