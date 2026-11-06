import { readSync } from 'node:fs';
export { createChildSummary } from './summary';

export type TranscriptCheckpoint = { offset: number; tail: Buffer };
const CHUNK_BYTES = 1024 * 1024;
const TAIL_BYTES = 256;

/** Exact JSONL rows, with cooperative checkpoints even inside a long native row. */
export function* readTranscriptRows(fd: number, progress: TranscriptCheckpoint, size: number,
  consume: (line: string) => boolean): Generator<void> {
  let pieces: Buffer[] = [];
  let carryBytes = 0;
  while (progress.offset + carryBytes < size) {
    const wanted = Math.min(CHUNK_BYTES, size - progress.offset - carryBytes);
    const buffer = Buffer.allocUnsafe(wanted);
    const count = readSync(fd, buffer, 0, wanted, progress.offset + carryBytes);
    if (count === 0) break;
    const chunk = buffer.subarray(0, count);
    const end = chunk.lastIndexOf(0x0a);
    if (end < 0) {
      pieces.push(chunk); carryBytes += count;
      yield;
      continue;
    }
    const completed = carryBytes ? Buffer.concat([...pieces, chunk.subarray(0, end + 1)], carryBytes + end + 1)
      : chunk.subarray(0, end + 1);
    let rows = 0;
    for (const line of completed.toString('utf8').split('\n')) {
      consume(line);
      if (++rows % 64 === 0) yield;
    }
    progress.offset += completed.length;
    progress.tail = Buffer.from(completed.subarray(Math.max(0, completed.length - TAIL_BYTES)));
    const remaining = chunk.subarray(end + 1);
    pieces = remaining.length ? [remaining] : [];
    carryBytes = remaining.length;
    yield;
  }
  if (carryBytes) {
    const last = Buffer.concat(pieces, carryBytes);
    // Complete final JSON counts once; an incomplete append is retried from its last checkpoint.
    if (consume(last.toString('utf8'))) {
      progress.offset += carryBytes;
      progress.tail = Buffer.from(last.subarray(Math.max(0, last.length - TAIL_BYTES)));
    }
  }
}
