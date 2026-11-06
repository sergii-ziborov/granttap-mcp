import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ChildThreadInfo } from '../../../../../../../packages/protocol/schema';
import { claudeTranscriptRecord, pastedImageLabel } from '../../../support/activity-helpers';
import { childTitle } from '../../../support/child-threads';
import { stateFor, ts } from '../../../support/common';

type Options = { sumUsage: (usage: any) => number | null | undefined; remember: (threadId: string) => void };

/** Summary state contains metadata only; transcript rows can be discarded immediately. */
export function createChildSummary(path: string, parentSessionId: string, options: Options) {
  let threadId = basename(path, '.jsonl').replace(/^agent-/, '');
  let title: string | undefined;
  let startedAt = 0, lastActivityAt = 0, tokensSession = 0, tokensLastTurn = 0;
  return {
    add(row: any): void {
      if (!row || !claudeTranscriptRecord(row)) return;
      if (typeof row.agentId === 'string' && row.agentId) threadId = row.agentId;
      const at = ts(row.timestamp);
      if (at) {
        if (!startedAt || at < startedAt) startedAt = at;
        if (at > lastActivityAt) lastActivityAt = at;
      }
      if (!title && (row.type === 'user' || row.message?.role === 'user')) {
        const content = row.message?.content;
        if (typeof content === 'string') title = childTitle(content);
        else if (Array.isArray(content)) title = childTitle(content
          .filter((block: any) => block?.type === 'text' && !pastedImageLabel(block, content))
          .map((block: any) => block.text).join('\n'));
      }
      const spent = options.sumUsage(row.message?.usage);
      if (spent != null) { tokensSession += spent; tokensLastTurn = spent; }
    },
    finish(): ChildThreadInfo {
      try {
        const stat = statSync(path);
        startedAt ||= stat.birthtimeMs || stat.mtimeMs;
        lastActivityAt = Math.max(lastActivityAt, stat.mtimeMs);
      } catch { /* Parsed timestamps still make a removed child usable. */ }
      options.remember(threadId);
      return { threadId, parentThreadId: parentSessionId, title, depth: 1, state: stateFor(lastActivityAt),
        startedAt: startedAt || lastActivityAt, lastActivityAt, tokensSession, tokensLastTurn };
    },
  };
}
