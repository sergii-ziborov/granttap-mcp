import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityEntry } from '../../../../../packages/protocol/schema';
import { newProjection } from './projection';
import { consumeConversationChunk as consume, type ConversationReader as Reader } from './reader';
export { captureGrokConversation } from './capture';

const readers = new Map<string, Reader>();
const maximumBytes = 64 * 1024 * 1024;

/** Read the native restore transcript, independently of compacted model context. */
export function readGrokConversation(directory: string, sessionId: string, requireComplete = false): ActivityEntry[] | undefined {
  const path = join(directory, 'updates.jsonl');
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    let reader = readers.get(path);
    if (!reader || reader.projection.sessionId !== sessionId
        || reader.device !== stat.dev || reader.inode !== stat.ino || stat.size < reader.offset
        || stat.size === reader.offset && stat.mtimeMs !== reader.modified) {
      const offset = Math.max(0, stat.size - maximumBytes);
      reader = { device: stat.dev, inode: stat.ino, offset, modified: 0, pending: Buffer.alloc(0),
        discard: offset > 0, incomplete: offset > 0, projection: newProjection(sessionId) };
    }
    if (reader.offset < stat.size) {
      fd = openSync(path, 'r');
      const bytes = Buffer.alloc(64 * 1024), limit = Math.min(stat.size, reader.offset + maximumBytes);
      while (reader.offset < limit) {
        const count = readSync(fd, bytes, 0, Math.min(bytes.length, limit - reader.offset), reader.offset);
        if (!count) break;
        consume(reader, bytes.subarray(0, count));
      }
    }
    reader.modified = stat.mtimeMs;
    readers.delete(path); readers.set(path, reader);
    while (readers.size > 8) readers.delete(readers.keys().next().value!);
    if (requireComplete && (reader.incomplete || reader.pending.length || reader.offset < stat.size || reader.projection.bounded)) {
      throw new Error('The full native Grok conversation exceeds its safe capture bound or is still being written.');
    }
    return reader.projection.entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (requireComplete) throw error;
    return undefined;
  } finally { if (fd !== undefined) closeSync(fd); }
}
