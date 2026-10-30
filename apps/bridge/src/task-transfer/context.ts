import { setImmediate } from 'node:timers/promises';
import type { SessionInfo, TaskCapsule } from '../../../../packages/protocol/schema';
import { captureContextImages } from './context/images';
import { TransferArchive } from './context/archive';
import { MAX_TRANSFER_CONTEXT_BYTES, transferDigest } from './persistence';
import { transferContextReaders, type ContextReaders } from './context/readers';

/** Every visible root-chat page is carried; hidden reasoning is never a context source. */
export async function captureTransferContext(session: SessionInfo, capsule: TaskCapsule,
  readers?: ContextReaders): Promise<{ context: string; hash: string }> {
  if (session.state === 'working') throw new Error('Pause or finish the current turn before transferring this Task.');
  const source = readers ?? await transferContextReaders(session);
  let cursor: string | undefined, bytes = 0;
  let latestFingerprint: string | undefined;
  const cursors = new Set<string>(), entries = new Map<string, TransferArchive["entries"][number]>();
  while (true) {
    const page = source.page(session, cursor);
    if (!page) throw new Error('The full visible conversation could not be read. No partial transfer was sent.');
    if (page.state === 'working') throw new Error('Pause or finish the current turn before transferring this Task.');
    if (!cursor) latestFingerprint = transferDigest(JSON.stringify(page.entries));
    for (const row of page.entries) {
      if (row.childThreadId || entries.has(row.id)) continue;
      if (!['user', 'message', 'final', 'tool', 'status'].includes(row.kind)) continue;
      const images = captureContextImages(session, row, cursor, source.image);
      const entry = { id: row.id, role: row.kind === 'message' || row.kind === 'final' ? 'assistant' as const : row.kind,
        text: row.text, at: row.createdAt, ...(images.length ? { images } : {}) };
      entries.set(row.id, entry); bytes += Buffer.byteLength(JSON.stringify(entry));
      if (bytes > MAX_TRANSFER_CONTEXT_BYTES - 200_000) throw new Error('The complete context exceeds the transfer bound.');
    }
    if (!page.history?.hasMore) break;
    const next = page.history.cursor;
    if (!next || cursors.has(next)) throw new Error('The full conversation cursor could not be confirmed.');
    cursors.add(next); cursor = next; await setImmediate();
  }
  const latest = source.page(session);
  if (!latest || latest.state === 'working' || source.unchanged?.() === false
    || transferDigest(JSON.stringify(latest.entries)) !== latestFingerprint) {
    throw new Error('The conversation changed during capture. No incomplete transfer was sent; retry after the turn finishes.');
  }
  const archive = TransferArchive.parse({ version: 1, facts: capsule,
    entries: [...entries.values()].sort((a, b) => a.at - b.at) });
  const context = JSON.stringify(archive);
  if (Buffer.byteLength(context) > MAX_TRANSFER_CONTEXT_BYTES) throw new Error('The complete context exceeds the transfer bound.');
  return { context, hash: transferDigest(context) };
}
