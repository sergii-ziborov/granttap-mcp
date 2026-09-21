import {
  claudeChildLogPathsBySession,
  claudeLogPathBySession,
  claudeSummaryCache,
} from "./shared";
import { parseClaudeFile } from "./parse";
import { recentLogs, claudeProjectsRoot, MAX_FILES, TOKEN_WINDOW_MS, type Scan } from "../../support/common";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";

export function scanClaude(maxFiles = MAX_FILES): Scan {
  const root = claudeProjectsRoot();
  const sessions: SessionInfo[] = [];
  let tokensRecent = 0;
  const listed = recentLogs(root, 2, maxFiles + 1);
  const files = listed.slice(0, maxFiles);
  const activeFiles = new Set(files);
  const seenSessionIds = new Set<string>();
  claudeLogPathBySession.clear();
  claudeChildLogPathsBySession.clear();

  for (const file of files) {
    const parsed = parseClaudeFile(file);
    if (!parsed || seenSessionIds.has(parsed.session.sessionId)) continue;
    seenSessionIds.add(parsed.session.sessionId);
    claudeLogPathBySession.set(parsed.session.sessionId, file);
    claudeChildLogPathsBySession.set(parsed.session.sessionId, parsed.childPaths);
    if (Date.now() - parsed.session.lastActivityAt <= TOKEN_WINDOW_MS) {
      tokensRecent += parsed.tokensSession;
    }
    sessions.push(parsed.session);
  }
  for (const file of claudeSummaryCache.keys()) {
    if (!activeFiles.has(file)) claudeSummaryCache.delete(file);
  }
  return { sessions, tokensRecent, sourceLimited: listed.length > maxFiles };
}
