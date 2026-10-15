import { dirname } from 'node:path';
import type { SessionActivity, SessionInfo } from '../../../../../packages/protocol/schema';
import { localTaskTransfers } from '../runtime/local';
import { TransferProjection } from './storage';

function projectionFor(session: SessionInfo): TransferProjection | undefined {
  if (!/^transfer-[a-f0-9]{48}$/.test(session.sessionId)) return undefined;
  const path = localTaskTransfers().contextPath(session.sessionId)!;
  return new TransferProjection(dirname(path), session.sessionId);
}

/** Saved source messages remain browsable even while the source computer is offline. */
export function transferHistory(session: SessionInfo, cursor?: string): SessionActivity | undefined {
  if (cursor != null && !/^transfer-context:\d+$/.test(cursor)) return undefined;
  const page = projectionFor(session)?.page(cursor ? Number(cursor.split(':')[1]) : undefined);
  if (!page) return undefined;
  const { from } = page;
  return { type: 'session.activity', sessionId: session.sessionId, agent: session.agent, state: session.state,
    entries: page.entries.map(row => ({ id: `transferred:${row.id}`,
      kind: row.role === 'assistant' ? 'message' : row.role, text: row.text, createdAt: row.at,
      images: row.images?.map(image => ({ id: image.id, name: image.name,
        markdown: `![Image](granttap-image:${encodeURIComponent(image.id)})` })) })),
    generatedAt: Date.now(), history: { hasMore: from > 0, ...(from ? { cursor: `transfer-context:${from}` } : {}),
      ...(cursor ? { requestedCursor: cursor } : {}) } };
}

export function transferredImage(session: SessionInfo, imageId: string, offset: number) {
  return projectionFor(session)?.image(imageId, offset);
}
