import type { SessionInfo, SessionActivity } from '../../../../../packages/protocol/schema';
import { readTranscriptHistory, nativeTranscriptImage } from '../../transcript-history';
import { cursorActivity } from '../../sessions/cursor';
import { grokActivity, grokConversationForTransfer } from '../../sessions/scan/grok';
import { localTaskTransfers } from '../runtime/local';
import { transferHistory } from '../projection';

export type ContextReaders = {
  page: (session: SessionInfo, cursor?: string) => SessionActivity | undefined;
  image?: typeof nativeTranscriptImage;
  unchanged?: () => boolean;
};

function nativePage(session: SessionInfo, entries: SessionActivity['entries']): SessionActivity {
  const native = localTaskTransfers().nativeSession(session);
  const inherited = native.sessionId !== session.sessionId ? transferHistory(session) : undefined;
  const until = inherited ? inherited.entries.length + Number(inherited.history?.cursor?.split(':')[1] ?? 0) : 0;
  return { type: 'session.activity', sessionId: session.sessionId, agent: session.agent,
    state: session.state, generatedAt: Date.now(), entries,
    ...(until ? { history: { hasMore: true, cursor: `transfer-context:${until}` } } : {}) };
}

function visiblePage(session: SessionInfo, cursor?: string): SessionActivity | undefined {
  if (cursor?.startsWith('transfer-context:')) return transferHistory(session, cursor);
  if (session.agent === 'cursor' || session.agent === 'grok') {
    const native = localTaskTransfers().nativeSession(session);
    const entries = session.agent === 'cursor' ? cursorActivity(native, true) : grokActivity(native, true);
    if (!entries.length && native.sessionId !== session.sessionId) return transferHistory(session);
    return nativePage(session, entries);
  }
  return readTranscriptHistory(session, cursor);
}

/** Complete Grok captures have their own projection and attachment bytes, scoped to this operation. */
export async function transferContextReaders(session: SessionInfo): Promise<ContextReaders> {
  if (session.agent !== 'grok') return { page: visiblePage };
  const native = localTaskTransfers().nativeSession(session);
  const captured = await grokConversationForTransfer(native);
  if (!captured) return { page: visiblePage };
  return {
    page: (input, cursor) => cursor?.startsWith('transfer-context:')
      ? transferHistory(input, cursor) : nativePage(input, captured.entries),
    image: (input, id, offset, cursor) => cursor?.startsWith('transfer-context:')
      ? nativeTranscriptImage(input, id, offset, cursor) : captured.image(input, id, offset),
    unchanged: captured.unchanged,
  };
}
