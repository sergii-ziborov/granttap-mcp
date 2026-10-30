import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { newProjection } from './projection';
import { consumeConversationChunk, type ConversationReader } from './reader';

const maximumCaptureBytes = 512 * 1024 * 1024;

/** Read from the start, yielding between chunks; UI tail caches are never a transfer source. */
export async function captureGrokConversation(directory: string, sessionId: string) {
  const path = join(directory, 'updates.jsonl');
  let before;
  try { before = statSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (before.size > maximumCaptureBytes) throw new Error('The native Grok log exceeds the complete capture budget.');
  const reader: ConversationReader = { device: before.dev, inode: before.ino, offset: 0,
    modified: before.mtimeMs, pending: Buffer.alloc(0), discard: false, incomplete: false,
    projection: newProjection(sessionId, true) };
  if (before.size) {
    const stream = createReadStream(path, { end: before.size - 1, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      consumeConversationChunk(reader, chunk as Buffer);
      if (reader.incomplete || reader.projection.bounded) {
        throw new Error('The complete native Grok conversation exceeds its transfer budget or contains unrecoverable data.');
      }
      await setImmediate();
    }
  }
  const unchanged = () => {
    try {
      const current = statSync(path);
      return current.dev === before.dev && current.ino === before.ino
        && current.size === before.size && current.mtimeMs === before.mtimeMs;
    } catch { return false; }
  };
  if (reader.pending.length || reader.offset !== before.size || !unchanged()) {
    throw new Error('The Grok conversation changed or is still being written. No partial transfer was sent.');
  }
  const image = (_session: unknown, id: string, offset: number) => {
    const value = reader.projection.images?.get(id);
    if (!value || !Number.isSafeInteger(offset) || offset < 0 || offset >= value.bytes.length) return undefined;
    return { mime_type: value.mime, total_bytes: value.bytes.length, offset,
      data_base64: value.bytes.subarray(offset, offset + 64 * 1024).toString('base64') };
  };
  return { entries: reader.projection.entries, image, unchanged };
}
