import { basename } from 'node:path';
import type { ActivityEntry, SessionInfo } from '../../../../../../../packages/protocol/schema';
import { readNativeTranscriptWindow } from '../../../../transcript-history';
import { appendClaudeActivity, claudeCapabilityUsage } from '../activity';
import { claudeChildLogPaths, claudeChildLogPathsBySession, claudeChildPathByThread,
  claudeChildSummary, claudeLogPath } from '../shared';

/** A child request must not parse the parent and every sibling conversation. */
export function claudeThreadActivity(session: SessionInfo, threadId: string): ActivityEntry[] {
  const parent = claudeLogPath(session.sessionId);
  if (!parent) return [];
  const paths = claudeChildLogPathsBySession.get(session.sessionId)
    ?? claudeChildLogPaths(parent, session.sessionId);
  const known = claudeChildPathByThread.get(`${session.sessionId}\0${threadId}`);
  const candidate = paths.find(path => path === known || basename(path, '.jsonl') === `agent-${threadId}`);
  for (const path of candidate ? [candidate] : paths) {
    try {
      const lines = readNativeTranscriptWindow(path, threadId)?.lines.map(line => line.text);
      if (!lines) continue;
      const inferred = claudeChildSummary(path, session.sessionId, lines);
      if (inferred.threadId !== threadId) continue;
      const child = session.childThreads?.find(item => item.threadId === threadId) ?? inferred;
      const observations = new Map(claudeCapabilityUsage(session, lines, threadId).map(item => [item.sourceId, item]));
      const out: ActivityEntry[] = [];
      appendClaudeActivity({ out, seen: new Set(), session, lines, observations, child });
      return out;
    } catch { /* A removed or incomplete child log does not prevent opening the root chat. */ }
  }
  return [];
}
