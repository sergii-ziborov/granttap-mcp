import { finishScan, finishScanCooperatively } from "../../cooperative-scan";
import { withCheckoutObservationCache } from "../../support/repository-checkout";
import {
  claudeChildLogPathsBySession,
  claudeLogPathBySession,
  claudeSummaryCache,
} from "./shared";
import { parseClaudeFile } from "./parse";
import { recentLogs, claudeProjectsRoot, MAX_FILES, TOKEN_WINDOW_MS, type Scan } from "../../support/common";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";

export function scanClaude(maxFiles = MAX_FILES): Scan {
  return withCheckoutObservationCache(() => finishScan(scanClaudeCatalog(maxFiles)));
}

export function scanClaudeCooperatively(maxFiles = MAX_FILES): Promise<Scan> {
  return withCheckoutObservationCache(() => finishScanCooperatively(scanClaudeCatalog(maxFiles)));
}

function* scanClaudeCatalog(maxFiles: number): Generator<void, Scan> {
  const root = claudeProjectsRoot();
  const sessions: SessionInfo[] = [];
  let tokensRecent = 0;
  const listed = recentLogs(root, 2, maxFiles + 1);
  const files = listed.slice(0, maxFiles);
  const activeFiles = new Set(files);
  const seenSessionIds = new Set<string>();
  const sources: Array<{ sessionId: string; file: string; childPaths: string[] }> = [];

  for (const file of files) {
    yield;
    const parsed = parseClaudeFile(file);
    if (!parsed || seenSessionIds.has(parsed.session.sessionId)) continue;
    seenSessionIds.add(parsed.session.sessionId);
    sources.push({ sessionId: parsed.session.sessionId, file, childPaths: parsed.childPaths });
    if (Date.now() - parsed.session.lastActivityAt <= TOKEN_WINDOW_MS) {
      tokensRecent += parsed.tokensSession;
    }
    sessions.push(parsed.session);
  }
  for (const file of claudeSummaryCache.keys()) {
    if (!activeFiles.has(file)) claudeSummaryCache.delete(file);
  }
  claudeLogPathBySession.clear();
  claudeChildLogPathsBySession.clear();
  for (const source of sources) {
    claudeLogPathBySession.set(source.sessionId, source.file);
    claudeChildLogPathsBySession.set(source.sessionId, source.childPaths);
  }
  return { sessions, tokensRecent, sourceLimited: listed.length > maxFiles };
}
