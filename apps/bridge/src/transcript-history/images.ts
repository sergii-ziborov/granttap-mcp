import { codexLogPathBySession } from "../sessions/scan/codex/shared";
import { safeParse, ts } from "../sessions/support/common";
import { previousNativeLines } from "./native-lines";

/** Locate an older image row without copying image bytes into chat pages. */
export function nativeImageLines(sessionId: string, entryId: string): string[] | undefined {
  if (!entryId.startsWith(`${sessionId}:`)) return undefined;
  const stamp = Number(entryId.slice(sessionId.length + 1).split(":")[0]);
  const path = codexLogPathBySession.get(sessionId);
  if (!path || !Number.isFinite(stamp)) return undefined;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 32; page++) {
      const window = previousNativeLines(path, sessionId, cursor);
      if (!window) return undefined;
      let earliest = Infinity;
      for (const line of window.lines) {
        const row = safeParse(line.text), p = row?.payload;
        const createdAt = ts(row?.timestamp);
        if (createdAt) earliest = Math.min(earliest, createdAt);
        if (createdAt === stamp && row?.type === "response_item" && p?.type === "message"
          && p.role === "user" && Array.isArray(p.content)) return [line.text];
      }
      if (window.start === 0 || earliest < stamp) return undefined;
      cursor = window.cursorAt(window.lines[0]?.offset ?? window.start);
    }
  } catch { return undefined; }
  return undefined;
}
