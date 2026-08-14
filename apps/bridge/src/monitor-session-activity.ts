import type { SessionActivity, SessionInfo } from "../../../packages/protocol/schema";
import { scanSessionActivity } from "./sessions";

type ActivityReader = (session: SessionInfo) => SessionActivity;

/**
 * A provider transcript is megabyte-scale blocking IO, and the phone asks for
 * the open chat every few seconds while every catalog publish previews more.
 * Re-reading each time saturates the event loop, which starves the WebSocket
 * and makes a healthy computer look offline.
 *
 * A session's own activity clock is the honest invalidation key: `lastActivityAt`
 * comes from the newest transcript row, so it moves exactly when there is
 * something new to read.
 */
function cacheKey(session: SessionInfo): string {
  const children = session.childThreads?.map((child) => child.threadId).join(",") ?? "";
  return [
    session.agent,
    session.sessionId,
    session.lastActivityAt,
    session.state,
    children,
  ].join("\0");
}

export function sessionActivityCache(
  read: ActivityReader,
  capacity = 64,
): (session: SessionInfo, forceScan?: boolean) => SessionActivity {
  const cache = new Map<string, SessionActivity>();
  return (session, forceScan = false) => {
    const key = cacheKey(session);
    if (!forceScan) {
      const hit = cache.get(key);
      // Refresh recency so a chat the user keeps open is never the eviction
      // victim of a burst of one-off history previews.
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
    }
    const activity = read(session);
    cache.delete(key);
    cache.set(key, activity);
    const prefix = `${session.agent}\0${session.sessionId}\0`;
    for (const existing of [...cache.keys()]) {
      if (existing !== key && existing.startsWith(prefix)) cache.delete(existing);
    }
    while (cache.size > capacity) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return activity;
  };
}

export const cachedSessionActivity = sessionActivityCache(scanSessionActivity);
