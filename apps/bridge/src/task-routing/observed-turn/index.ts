import type { SessionInfo } from '../../../../../packages/protocol/schema';
import { codexLogPathForSession } from '../../sessions/scan/codex/shared';
import { localTaskTransfers } from '../../task-transfer';
import { readLatestCodexTurnControls } from './codex';

/** Native turn controls are observations; a missing value never inherits an older catalog guess. */
export async function observedRoutingSession(session: SessionInfo): Promise<SessionInfo> {
  if (session.agent !== 'codex') return session;
  const native = localTaskTransfers().nativeSession(session);
  const path = codexLogPathForSession(native.sessionId, native.startedAt);
  try {
    const controls = path ? await readLatestCodexTurnControls(path) : undefined;
    return { ...session, model: controls?.model, effort: controls?.effort };
  } catch { return { ...session, model: undefined, effort: undefined }; }
}
