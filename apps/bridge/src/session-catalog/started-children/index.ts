/**
 * Hundreds of short headless runs one chat started (`codex exec` per picture) are not hundreds of
 * catalog rows. A finished run another chat started is kept as a row only among the newest few of
 * that parent's; the rest are counted on the parent as `startedChildren`. A running child, a child
 * whose parent is not in the list, and every other chat stay rows. The full catalog still finds a
 * child that is no row (a phone opening it, a message for it).
 *
 * The counts cover every run the parent is known to have started, not only the ones the catalog's
 * window still reads: each finished run is written down when a catalog sees it (`ledger.ts`), and
 * runs the window never held are read by a slower pass (`beyond-window.ts`).
 */
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { lineageAgent, type StartedBy } from "../../started-by";
import { countedRun, countedRuns, countStartedRuns, type CountedRun } from "./ledger";

export { countedRun, countedRuns, countStartedRuns, startedRunsPath, type CountedRun } from "./ledger";
export { noteCatalogParents, settleRunsBeyondWindow } from "./beyond-window";
export { publishStartedChildren, startedChildIds, MAX_PUBLISHED_CHILDREN } from "./publish";

/** Finished children of one parent kept as rows, newest first. */
export const FINISHED_CHILD_ROWS = 3;

type Summary = NonNullable<SessionInfo["startedChildren"]>;

const key = (agent: string, sessionId: string) => `${agent}\0${sessionId}`;

/** Each finished child this list holds, written down under the chat that started it. */
export function recordStartedChildren(sessions: readonly SessionInfo[], now = Date.now()): number {
  const found = sessions.flatMap((session) => {
    const run = session.startedBy ? countedRun(session) : undefined;
    return run ? [{ parent: session.startedBy as StartedBy, run }] : [];
  });
  try {
    return found.length ? countStartedRuns(found, now) : 0;
  } catch {
    return 0; // Written down by the next catalog; this one counts from its own rows.
  }
}

/** What every finished run a chat started came to: the written-down runs and the listed ones. */
function summary(counted: ReadonlyMap<string, CountedRun>, listed: readonly CountedRun[]): Summary | undefined {
  if (counted.size === 0 && listed.length === 0) return undefined;
  const runs = new Map(counted);
  for (const run of listed) runs.set(run.sessionId, run);
  if (runs.size === 0) return undefined;
  let stopped = 0, limited = 0, pictures = 0, lastAt = 0;
  for (const run of runs.values()) {
    if (run.end !== "answered") stopped += 1;
    if (run.end === "limit") limited += 1;
    if (run.picture) pictures += 1;
    lastAt = Math.max(lastAt, run.at);
  }
  return { finished: runs.size, stopped, limited, pictures, lastAt };
}

/** The finished children each listed parent has among these rows. */
function finishedChildren(sessions: readonly SessionInfo[]): Map<string, SessionInfo[]> {
  const present = new Set(sessions.map((session) => key(session.agent, session.sessionId)));
  const finished = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const parent = session.startedBy && key(session.startedBy.agent, session.startedBy.sessionId);
    if (!parent || session.state !== "idle" || !present.has(parent)) continue;
    finished.set(parent, [...(finished.get(parent) ?? []), session]);
  }
  return finished;
}

function withSummaries(sessions: readonly SessionInfo[], finished: ReadonlyMap<string, SessionInfo[]>): SessionInfo[] {
  const counted = countedRuns();
  return sessions.map((session) => {
    if (!lineageAgent(session.agent)) return session;
    const listed = (finished.get(key(session.agent, session.sessionId)) ?? []).flatMap((child) => countedRun(child) ?? []);
    const counts = summary(counted.of({ agent: session.agent, sessionId: session.sessionId }), listed);
    return counts ? { ...session, startedChildren: counts } : session;
  });
}

export function compactStartedChildren(sessions: readonly SessionInfo[], keep = FINISHED_CHILD_ROWS): SessionInfo[] {
  const finished = finishedChildren(sessions);
  const dropped = new Set<string>();
  for (const children of finished.values()) {
    const newest = [...children].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    for (const child of newest.slice(keep)) dropped.add(key(child.agent, child.sessionId));
  }
  return withSummaries(sessions.filter((session) => !dropped.has(key(session.agent, session.sessionId))), finished);
}

/** The same counts on every listed parent, with no row left out: a page of history lists every chat. */
export function countStartedChildren(sessions: readonly SessionInfo[]): SessionInfo[] {
  return withSummaries(sessions, finishedChildren(sessions));
}
