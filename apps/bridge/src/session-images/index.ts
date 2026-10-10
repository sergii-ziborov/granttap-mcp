import type { SessionImageQuery, SessionInfo, SessionActivity, ActivityEntry } from '../../../../packages/protocol/schema';
import { SessionImageChunk } from '../../../../packages/protocol/schema';
import type { RelayClient } from '../../../../packages/core/relay-client';
import { sendSessionPayload } from '../host/session-keys';
import { readTranscriptHistory } from '../transcript-history';
import { cachedSessionActivity } from '../monitor/support/session-activity';
import { scanSessions, scanSessionHistory } from '../sessions';
import { sessionImageChunk, transcriptImages } from '../../../mcp/src/desktop/image';

export function activityWithImages(activity: SessionActivity): SessionActivity {
  return { ...activity, entries: activity.entries.map((entry: ActivityEntry) => {
    const images = transcriptImages(entry);
    return images.length ? { ...entry, images } : entry;
  }) };
}

/** Exact advertised row only. No request-supplied filesystem path is accepted. */
export function readSessionImage(query: SessionImageQuery, session: SessionInfo,
  activity: SessionActivity) {
  if (session.sessionId !== query.sessionId || activity.sessionId !== query.sessionId) return undefined;
  return sessionImageChunk(session, activity, query.imageId, query.offset, query.historyCursor);
}

export async function publishSessionImage(client: RelayClient, query: SessionImageQuery): Promise<boolean> {
  const session = scanSessions().sessions.find(s => s.sessionId === query.sessionId)
    ?? scanSessionHistory().find(s => s.sessionId === query.sessionId);
  const activity = session ? readTranscriptHistory(session, query.historyCursor)
    ?? cachedSessionActivity(session) : undefined;
  const chunk = session && activity ? readSessionImage(query, session, activity) : undefined;
  await sendSessionPayload(client, SessionImageChunk.parse({ type: 'session.image.chunk', sessionId: query.sessionId,
    requestId: query.requestId, imageId: query.imageId, offset: query.offset,
    ...(chunk ? { mimeType: chunk.mime_type, totalBytes: chunk.total_bytes,
      dataBase64: chunk.data_base64 } : { unavailable: true }) }), query.sessionId,
    'phone', { ttlMs: 20_000, reliable: false });
  return chunk !== undefined;
}
