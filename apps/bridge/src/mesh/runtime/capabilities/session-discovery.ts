import type { SessionInfo } from "../../../../../../packages/protocol/schema";

/** Native session IDs are scoped to their provider on this endpoint. */
export function deduplicateNativeSessions(
  history: SessionInfo[], current: SessionInfo[],
): SessionInfo[] {
  const byIdentity = new Map<string, SessionInfo>();
  for (const session of [...history, ...current]) {
    byIdentity.set(`${session.agent}\0${session.sessionId}`, session);
  }
  return [...byIdentity.values()];
}
