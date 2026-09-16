import { closeSync, lstatSync, openSync, readSync } from "node:fs";

const MAX_INITIAL_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;

export type InvocationLogCursor = {
  dev: number;
  ino: number;
  offset: number;
  lineStart: number;
  partial: Buffer;
  skipping: boolean;
};

export type InvocationLogBatch = {
  lines: Array<{ line: string; offset: number }>;
  gaps: number[];
  next: InvocationLogCursor;
};

/** A bounded, resumable JSONL read; the caller commits `next` only after Engine accepts the batch. */
export function readInvocationBatch(path: string, cursor?: InvocationLogCursor): InvocationLogBatch {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("transcript is not a regular file");
  const rotated = cursor && (cursor.dev !== stat.dev || cursor.ino !== stat.ino || stat.size < cursor.offset);
  const reuse = Boolean(cursor && !rotated);
  const initial = reuse ? cursor.offset : Math.max(0, stat.size - MAX_INITIAL_BYTES);
  const gaps = rotated ? [cursor.offset] : !reuse && initial > 0 ? [initial] : [];
  const start = initial;
  const length = Math.min(MAX_BATCH_BYTES, Math.max(0, stat.size - start));
  const chunk = Buffer.allocUnsafe(length);
  let read = 0;
  if (length > 0) {
    const fd = openSync(path, "r");
    try { read = readSync(fd, chunk, 0, length, start); }
    finally { closeSync(fd); }
  }
  const offset = start + read;
  const prior = reuse ? cursor.partial : Buffer.alloc(0);
  const combined = Buffer.concat([prior, chunk.subarray(0, read)]);
  const base = start - prior.length;
  const lines: InvocationLogBatch["lines"] = [];
  let lineStart = reuse ? cursor.lineStart : start;
  let skipping = reuse ? cursor.skipping : initial > 0;
  let segmentStart = 0;
  for (let index = 0; index < combined.length; index += 1) {
    if (combined[index] !== 10) continue;
    const size = index - segmentStart;
    if (!skipping && size <= MAX_LINE_BYTES) {
      const line = combined.subarray(segmentStart, index).toString("utf8");
      lines.push({ line, offset: lineStart });
    } else if (!skipping) {
      gaps.push(lineStart);
    }
    segmentStart = index + 1;
    lineStart = base + segmentStart;
    skipping = false;
  }
  const trailing = combined.subarray(segmentStart);
  let partial = skipping ? Buffer.alloc(0) : Buffer.from(trailing);
  if (!skipping && partial.length > MAX_LINE_BYTES) {
    gaps.push(lineStart);
    skipping = true;
    partial = Buffer.alloc(0);
  }
  return {
    lines, gaps,
    next: { dev: stat.dev, ino: stat.ino, offset, lineStart, partial, skipping },
  };
}
