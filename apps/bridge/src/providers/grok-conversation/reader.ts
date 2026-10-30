import { projectConversationUpdate, type ConversationProjection } from './projection';

export type ConversationReader = { device: number; inode: number; offset: number; modified: number;
  pending: Buffer; discard: boolean; incomplete: boolean; projection: ConversationProjection };

const maximumRecord = 8 * 1024 * 1024;

/** Preserve native byte offsets across UTF-8 and incomplete JSON records. */
export function consumeConversationChunk(reader: ConversationReader, chunk: Buffer): void {
  const startOffset = reader.offset - reader.pending.length;
  const bytes = reader.pending.length ? Buffer.concat([reader.pending, chunk]) : chunk;
  let from = 0;
  for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, from)) {
    if (!reader.discard && end - from <= maximumRecord) {
      try {
        const value: unknown = JSON.parse(bytes.subarray(from, end).toString('utf8'));
        projectConversationUpdate(reader.projection, value, startOffset + from);
      } catch { reader.incomplete = true; }
    } else reader.incomplete = true;
    reader.discard = false; from = end + 1;
  }
  const remaining = bytes.subarray(from);
  reader.pending = remaining.length <= maximumRecord ? Buffer.from(remaining) : Buffer.alloc(0);
  if (remaining.length > maximumRecord) { reader.discard = true; reader.incomplete = true; }
  reader.offset += chunk.length;
}
