import type { ActivityEntry, SessionInfo } from "../../../../../packages/protocol/schema";
import { appendCodexActivity } from "../../sessions/scan/codex/activity";
import { codexLogPathForSession } from "../../sessions/scan/codex/shared";
import { appendClaudeActivity, claudeLogPath } from "../../sessions/scan/claude";
import { safeParse, ts } from "../../sessions/support/common";
import { previousNativeLines } from "../native-lines";

/** Recover only the exact previously advertised row in this native conversation. */
export function nativeTranscriptEntry(session: SessionInfo, entryId: string,
  cursor?: string): ActivityEntry | undefined {
  if (!entryId.startsWith(`${session.sessionId}:`)) return undefined;
  const path = session.agent === "codex" ? codexLogPathForSession(session.sessionId, session.startedAt)
    : session.agent === "claude" ? claudeLogPath(session.sessionId) : undefined;
  if (!path) return undefined;
  const stamp = session.agent === "codex" ? Number(entryId.slice(session.sessionId.length + 1).split(":")[0]) : undefined;
  if (stamp != null && !Number.isFinite(stamp)) return undefined;
  let pageCursor = cursor;
  try {
    while (true) {
      const window = previousNativeLines(path, session.sessionId, pageCursor);
      if (!window) return undefined;
      let earliest = Infinity;
      for (const line of window.lines) {
        const row = safeParse(line.text), at = ts(row?.timestamp);
        if (at) earliest = Math.min(earliest, at);
        if (stamp != null && at !== stamp) continue;
        const out: ActivityEntry[] = [], seen = new Set<string>(), observations = new Map();
        if (session.agent === "codex") {
          appendCodexActivity({ out, seen, session, lines: [line.text], observations,
            changes: new Map(), details: new Map(), fullText: true });
        } else {
          appendClaudeActivity({ out, seen, session, lines: [line.text], observations, fullText: true });
        }
        const found = out.find(entry => entry.id === entryId);
        if (found) return found;
      }
      if (window.start === 0 || (stamp != null && earliest < stamp)) return undefined;
      const next = window.lines[0]?.offset ?? window.start;
      if (next >= window.end) return undefined;
      pageCursor = window.cursorAt(next);
    }
  } catch { return undefined; }
}
