import { createHash } from "node:crypto";
import { openSync, closeSync, readSync, fstatSync } from "node:fs";

export type NativeLine = { text: string; offset: number };
const WINDOW_BYTES = 1024 * 1024;
const MAX_WINDOW_BYTES = 16 * WINDOW_BYTES;

function identityFor(path: string, sessionId: string, stat: {ino: number; birthtimeMs: number}) {
  return createHash("sha256").update(`${sessionId}\0${path}\0${stat.ino}\0${stat.birthtimeMs}`)
    .digest("hex").slice(0, 24);
}

/** Encode a known row offset without rereading the transcript body. */
export function nativeHistoryCursor(path: string, sessionId: string, offset: number) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) return undefined;
    return Buffer.from(JSON.stringify({identity: identityFor(path, sessionId, stat), offset}))
      .toString("base64url");
  } finally { closeSync(fd); }
}

function readWindow(fd: number, end: number, amount: number) {
  const start = Math.max(0, end - amount);
  const bytes = Buffer.alloc(end - start);
  const count = readSync(fd, bytes, 0, bytes.length, start);
  const lines: NativeLine[] = [];
  let from = start === 0 ? 0 : bytes.indexOf(10) + 1;
  if (start > 0 && from === 0) from = count;
  for (let i = from; i < count; i++) {
    if (bytes[i] !== 10) continue;
    if (i > from) lines.push({text: bytes.subarray(from, i).toString("utf8"), offset: start + from});
    from = i + 1;
  }
  return {lines, start};
}

/** Read a bounded older JSONL window. Cursors never carry a user supplied path. */
export function previousNativeLines(path: string, sessionId: string, cursor?: string) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    const identity = identityFor(path, sessionId, stat);
    let end = stat.size;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (decoded.identity !== identity || !Number.isSafeInteger(decoded.offset)
          || decoded.offset < 0 || decoded.offset > stat.size) return undefined;
        end = decoded.offset;
      } catch { return undefined; }
    }
    let amount = WINDOW_BYTES, window = readWindow(fd, end, amount);
    // Expand only when a complete row does not fit; long messages remain reachable.
    while (!window.lines.length && window.start > 0 && amount < MAX_WINDOW_BYTES) {
      amount *= 2;
      window = readWindow(fd, end, amount);
    }
    const encode = (offset: number) => Buffer.from(JSON.stringify({ identity, offset })).toString("base64url");
    return { ...window, end, cursorAt: encode };
  } finally { closeSync(fd); }
}
