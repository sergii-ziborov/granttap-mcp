import type { ActivityEntry, SessionActivity, SessionInfo } from '../../../../packages/protocol/schema';
import { localTaskTransfers } from '../task-transfer';
import { claudeActivity } from './scan/claude';
import { claudeThreadActivity } from './scan/claude/threads';
import { codexActivity } from './scan/codex';
import { cursorActivity } from './cursor';
import { grokActivity } from './scan/grok';

export function activityForSession(input: SessionInfo): ActivityEntry[] {
  const session = localTaskTransfers().nativeSession(input);
  if (session.agent === 'claude') return claudeActivity(session);
  if (session.agent === 'codex') return codexActivity(session);
  if (session.agent === 'cursor') return cursorActivity(session);
  if (session.agent === 'grok') return grokActivity(session);
  return [];
}

export const MAX_THREAD_ENTRIES = 60;

/** Read one nested conversation with a bounded native window, newest last. */
export function scanThreadActivity(input: SessionInfo, threadId: string): SessionActivity {
  const session = localTaskTransfers().nativeSession(input);
  const all = session.agent === 'claude' ? claudeThreadActivity(session, threadId) : activityForSession(input);
  const entries = all.filter(entry => entry.childThreadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_THREAD_ENTRIES);
  return { type: 'session.activity', sessionId: input.sessionId, agent: input.agent,
    state: input.state, threadId, entries, generatedAt: Date.now() };
}
