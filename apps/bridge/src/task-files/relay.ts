import type { RelayClient } from '../../../../packages/core/relay-client';
import { SessionWorkspaceResult, type SessionWorkspaceQuery } from '../../../../packages/protocol/schema';
import { publishedSession } from '../session-catalog';
import { sendSessionPayload } from '../host/session-keys';
import { readTaskWorkspace } from '.';
/** Session identity comes from the computer's admitted catalog, never from a requested root. */
export async function publishTaskWorkspace(client: RelayClient, query: SessionWorkspaceQuery, peerPublicKey?: string): Promise<boolean> {
    const session = publishedSession(client, query.sessionId);
    const result = session ? readTaskWorkspace(session, query) : undefined;
    await sendSessionPayload(client, SessionWorkspaceResult.parse({ type: 'session.workspace.result',
        sessionId: query.sessionId, requestId: query.requestId,
        ...(result ?? { path: query.path, truncated: false, unavailable: true }), createdAt: Date.now() }), query.sessionId, 'phone', { peerPublicKey, ttlMs: 30000, reliable: false });
    return result !== undefined;
}
