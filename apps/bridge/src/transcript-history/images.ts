import { codexLogPathBySession } from "../sessions/scan/codex/shared";
import { safeParse, ts } from "../sessions/support/common";
import { previousNativeLines } from "./native-lines";

/** Locate an older image row without copying image bytes into chat pages. */
export function nativeImageLines(sessionId: string, entryId: string): string[] | undefined {
  if (!entryId.startsWith(`${sessionId}:`)) return undefined;
  const [stampText, blockText] = entryId.slice(sessionId.length + 1).split(":");
  const stamp = Number(stampText), blockIndex = Number(blockText);
  const path = codexLogPathBySession.get(sessionId);
  if (!path || !Number.isFinite(stamp) || !Number.isSafeInteger(blockIndex) || blockIndex < 0) return undefined;
  let cursor: string | undefined;
  try {
    // A saved attachment does not expire when newer transcript windows append.
    // Each window stays bounded and its cursor must move toward the file start.
    while (true) {
      const window = previousNativeLines(path, sessionId, cursor);
      if (!window) return undefined;
      let earliest = Infinity;
      for (const line of window.lines) {
        const row = safeParse(line.text), p = row?.payload;
        const createdAt = ts(row?.timestamp);
        if (createdAt) earliest = Math.min(earliest, createdAt);
        if (createdAt === stamp && row?.type === "response_item" && p?.type === "message"
          && p.role === "user" && Array.isArray(p.content)
          && p.content[blockIndex]?.type === "input_image") return [line.text];
      }
      if (window.start === 0 || earliest < stamp) return undefined;
      const next = window.lines[0]?.offset ?? window.start;
      if (next >= window.end) return undefined;
      cursor = window.cursorAt(next);
    }
  } catch { return undefined; }
  return undefined;
}
