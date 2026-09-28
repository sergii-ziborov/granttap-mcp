import { createHash } from "node:crypto";
import { openSync, closeSync, readSync, fstatSync } from "node:fs";

export type NativeLine = { text: string; offset: number };
const WINDOW_BYTES = 16 * 1024 * 1024;

/** Read a bounded older JSONL window. Cursors never carry a user supplied path. */
export function previousNativeLines(path: string, sessionId: string, cursor?: string) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    const identity = createHash("sha256").update(`${sessionId}\0${path}\0${stat.ino}\0${stat.birthtimeMs}`).digest("hex").slice(0, 24);
    let end = stat.size;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (decoded.identity !== identity || !Number.isSafeInteger(decoded.offset)
          || decoded.offset < 0 || decoded.offset > stat.size) return undefined;
        end = decoded.offset;
      } catch { return undefined; }
    }
    const start = Math.max(0, end - WINDOW_BYTES);
    const bytes = Buffer.alloc(end - start);
    const count = readSync(fd, bytes, 0, bytes.length, start);
    const lines: NativeLine[] = [];
    let from = start === 0 ? 0 : bytes.indexOf(10) + 1;
    // A single oversized row is skipped in bounded increments; older pages remain reachable.
    if (start > 0 && from === 0) from = count;
    for (let i = from; i < count; i++) {
      if (bytes[i] !== 10) continue;
      if (i > from) lines.push({ text: bytes.subarray(from, i).toString("utf8"), offset: start + from });
      from = i + 1;
    }
    const encode = (offset: number) => Buffer.from(JSON.stringify({ identity, offset })).toString("base64url");
    return { lines, start, end, cursorAt: encode };
  } finally { closeSync(fd); }
}
