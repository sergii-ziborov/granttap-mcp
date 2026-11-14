import type { SessionImageQuery, SessionInfo, SessionActivity, ActivityEntry } from '../../../../packages/protocol/schema';
import { SessionImageChunk } from '../../../../packages/protocol/schema';
import type { RelayClient } from '../../../../packages/core/relay-client';
import { sendSessionPayload } from '../host/session-keys';
import { readTranscriptHistory } from '../transcript-history';
import { publishedSession } from '../session-catalog';
import { cachedSessionActivity } from '../monitor/support/session-activity';
import { findSessionCooperatively } from '../sessions';
import { sessionImageChunk, transcriptImages } from '../../../mcp/src/desktop/image';
import { helperRunPictureChunk, isHelperRunImageId } from '../helper-runs/pictures/store';

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

export async function publishSessionImage(client: RelayClient, query: SessionImageQuery,
  peerPublicKey?: string): Promise<boolean> {
  const chunk = isHelperRunImageId(query.imageId)
    // A picture kept from a helper run, offered only to the chat that started the run.
    ? helperRunPictureChunk(query.sessionId, query.imageId, query.offset)
    : await transcriptImageChunk(client, query);
  await sendSessionPayload(client, SessionImageChunk.parse({ type: 'session.image.chunk', sessionId: query.sessionId,
    requestId: query.requestId, imageId: query.imageId, offset: query.offset,
    ...(chunk ? { mimeType: chunk.mime_type, totalBytes: chunk.total_bytes,
      dataBase64: chunk.data_base64 } : { unavailable: true }) }), query.sessionId,
    'phone', { ttlMs: 20_000, reliable: false, peerPublicKey });
  return chunk !== undefined;
}

async function transcriptImageChunk(client: RelayClient, query: SessionImageQuery) {
  const session = publishedSession(client, query.sessionId)
    ?? await findSessionCooperatively(query.sessionId);
  const activity = session ? readTranscriptHistory(session, query.historyCursor)
    ?? cachedSessionActivity(session) : undefined;
  return session && activity ? readSessionImage(query, session, activity) : undefined;
}
