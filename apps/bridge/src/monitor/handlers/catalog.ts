import type { SessionInfo, SessionsStatus } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { sendSessionPayload } from "../../host/session-keys";
import { cachedSessionActivity } from "../support/session-activity";
import {
  scanSessionHistory,
  scanSessions,
  scanThreadActivity,
} from "../../sessions";

export const INTERVAL_MS = Number(
  process.env.GRANTTAP_MONITOR_INTERVAL_MS ?? process.env.NODVOX_MONITOR_INTERVAL_MS ?? 30_000,
);

export const HISTORY_PUBLISH_LIMIT = Number(
  process.env.GRANTTAP_MONITOR_HISTORY_LIMIT ?? 40,
);

/**
 * Keep the catalog bounded while retaining an explicitly open history task.
 * The phone can therefore reopen an older chat without restoring the previous
 * unbounded history + capability frame.
 */
export function boundedCatalogHistory(
  sessions: SessionInfo[],
  pinnedIds: ReadonlySet<string> = new Set(),
  limit = HISTORY_PUBLISH_LIMIT,
): SessionInfo[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 40;
  if (sessions.length <= safeLimit) return sessions;
  const pinned = sessions.filter((session) => pinnedIds.has(session.sessionId)).slice(0, safeLimit);
  const pinnedSet = new Set(pinned.map((session) => session.sessionId));
  const rest = sessions
    .filter((session) => !pinnedSet.has(session.sessionId))
    .slice(0, Math.max(0, safeLimit - pinned.length));
  return [...pinned, ...rest].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function resolveSession(sessionId: string, status?: SessionsStatus): SessionInfo | undefined {
  if (status) {
    return status.sessions.find((session) => session.sessionId === sessionId)
      ?? status.history?.find((session) => session.sessionId === sessionId);
  }
  return scanSessions().sessions.find((session) => session.sessionId === sessionId)
    ?? scanSessionHistory().find((session) => session.sessionId === sessionId);
}

/** Send one bounded transcript under the task-specific E2EE key. */
export async function publishSessionEvents(
  client: RelayClient,
  sessionId: string,
  status?: SessionsStatus,
  threadId?: string,
): Promise<boolean> {
  const session = resolveSession(sessionId, status);
  if (!session) return false;
  const activity = threadId ? scanThreadActivity(session, threadId) : cachedSessionActivity(session);
  await sendSessionPayload(client, activity, sessionId, "phone", {
    ttlMs: INTERVAL_MS * 24,
    reliable: false,
  });
  return true;
}
