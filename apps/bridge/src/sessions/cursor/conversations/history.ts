import { existsSync, lstatSync } from "node:fs";
import { ActivityEntry, type SessionActivity, type SessionInfo } from "../../../../../../packages/protocol/schema";
import { readNativeTranscriptWindow } from "../../../transcript-history";
import { archivePath, readConversation, sameConversationWorkspace } from "./storage";

/** Private visible-message archive; cursors are tied to this Task and this file's identity. */
export function cursorConversationHistory(session: SessionInfo, cursor?: string): SessionActivity | undefined {
  try {
    const record = readConversation(session.sessionId);
    if (!record || !session.cwd || !sameConversationWorkspace(record, session.cwd)) return;
    const path = archivePath(session.sessionId);
    if (!existsSync(path)) return;
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) return;
    const window = readNativeTranscriptWindow(path, session.sessionId, cursor); if (!window) return;
    const entries: { entry: ActivityEntry; offset: number }[] = [];
    for (const line of window.lines) {
      try { const parsed = ActivityEntry.safeParse(JSON.parse(line.text));
        if (parsed.success) entries.push({ entry: parsed.data, offset: line.offset }); } catch { /* Incomplete row. */ }
    }
    const picked: ActivityEntry[] = []; let bytes = 0, offset = window.end;
    for (const item of entries.reverse().slice(0, 80)) {
      const size = Buffer.byteLength(JSON.stringify(item.entry));
      if (bytes + size > 384 * 1024 && picked.length) break;
      picked.unshift(item.entry); offset = item.offset; bytes += size;
    }
    if (!cursor && record.live) picked.push(record.live);
    return { type: "session.activity", sessionId: session.sessionId, agent: "cursor",
      state: record.session.state, generatedAt: Date.now(), entries: picked, history: {
        hasMore: offset > 0, ...(offset > 0 ? { cursor: window.cursorAt(offset) } : {}),
        ...(cursor ? { requestedCursor: cursor } : {}),
      } };
  } catch { return undefined; }
}
