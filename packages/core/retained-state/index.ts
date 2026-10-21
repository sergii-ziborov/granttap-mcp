import { createHash } from 'node:crypto';
import type { Payload } from '../../protocol/schema';
import type { SendOptions } from '../relay-client-types';

/** Only replaceable read state is retained. Decisions and commands are never replayed as state. */
export function retainedPayloadOptions(payload: Payload): SendOptions {
  let scope: string | undefined;
  let revision: number | undefined;
  let session: string | undefined;
  let priority: 0 | 1 | 2 | 3 = 1;
  switch (payload.type) {
    case 'sessions.status': scope = payload.history ? 'catalog:history' : 'catalog'; revision = payload.generatedAt; break;
    case 'session.key.grant': session = payload.sessionId; scope = `key:${payload.sessionId}`; revision = payload.createdAt; priority = 0; break;
    case 'session.activity':
      session = payload.sessionId;
      if (!payload.history?.requestedCursor) scope = `activity:${payload.sessionId}:${payload.threadId ?? ''}`;
      revision = payload.generatedAt; priority = 3; break;
    case 'mesh.snapshot': session = payload.sessionId; scope = `mesh:${payload.projectId}`; revision = payload.generatedAt; priority = 2; break;
  }
  if (!scope || !Number.isSafeInteger(revision) || revision! < 0
    || Buffer.byteLength(JSON.stringify(payload)) > 900000) return {};
  return { stateGroup: session ? createHash('sha256').update(`session:${session}`).digest('hex') : undefined, stateKey: createHash('sha256').update(scope).digest('hex'), stateRevision: revision, statePriority: priority };
}
