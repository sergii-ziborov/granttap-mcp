/**
 * Hundreds of short headless runs one chat started (`codex exec` per picture) are not hundreds of
 * catalog rows. A finished run another chat started is kept as a row only among the newest few of
 * that parent's; the rest are counted on the parent as `startedChildren`. A running child, a child
 * whose parent is not in the list, and every other chat stay rows. The full catalog still finds a
 * child that is no row (a phone opening it, a message for it).
 */
import type { SessionInfo } from "../../../../packages/protocol/schema";

/** Finished children of one parent kept as rows, newest first. */
export const FINISHED_CHILD_ROWS = 3;

const key = (agent: string, sessionId: string) => `${agent}\0${sessionId}`;

export function compactStartedChildren(sessions: readonly SessionInfo[], keep = FINISHED_CHILD_ROWS): SessionInfo[] {
  const present = new Set(sessions.map((session) => key(session.agent, session.sessionId)));
  const finished = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const parent = session.startedBy && key(session.startedBy.agent, session.startedBy.sessionId);
    if (!parent || session.state !== "idle" || !present.has(parent)) continue;
    finished.set(parent, [...(finished.get(parent) ?? []), session]);
  }
  if (finished.size === 0) return [...sessions];
  const dropped = new Set<string>();
  const summaries = new Map<string, NonNullable<SessionInfo["startedChildren"]>>();
  for (const [parent, children] of finished) {
    const newest = [...children].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    for (const child of newest.slice(keep)) dropped.add(key(child.agent, child.sessionId));
    summaries.set(parent, { finished: children.length, stopped: children.filter((child) => child.stopped).length,
      pictures: children.filter((child) => child.images?.length).length, lastAt: newest[0]!.lastActivityAt });
  }
  return sessions.filter((session) => !dropped.has(key(session.agent, session.sessionId))).map((session) => {
    const summary = summaries.get(key(session.agent, session.sessionId));
    return summary ? { ...session, startedChildren: summary } : session;
  });
}
