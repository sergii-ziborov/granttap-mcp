import type {
  SessionInfo, SessionsHistoryPage, SessionsHistoryQuery,
} from "../../../../../packages/protocol/schema";
import { scanSessionHistoryForPaging, scanSessionHistoryForPagingCooperatively } from "../../sessions";
import { MAX_FILES } from "../../sessions/support/common";
import { loadRuntimeConfig } from "../../config";
import type { RelayClient } from "../../../../../packages/core/relay-client";

function cursorFor(session: SessionInfo): string {
  return Buffer.from(JSON.stringify([session.lastActivityAt, session.agent, session.sessionId]))
    .toString("base64url");
}

/**
 * The runs the given chats started, and the runs those started in turn, in the order given. The chats
 * themselves are left out: the phone asking has them already.
 */
function startedRuns(sessions: SessionInfo[], chats: string[]): SessionInfo[] {
  const heads = new Set(chats);
  const runs = new Set<SessionInfo>();
  for (let grew = true; grew;) {
    grew = false;
    for (const session of sessions) {
      const starter = session.startedBy?.sessionId;
      if (runs.has(session) || heads.has(session.sessionId) || !starter || !heads.has(starter)) continue;
      runs.add(session);
      heads.add(session.sessionId);
      grew = true;
    }
  }
  return sessions.filter((session) => runs.has(session));
}

/** Unknown anchors force a reset; they cannot silently skip or repeat history. */
export function historyPage(
  query: SessionsHistoryQuery,
  all: SessionInfo[],
  sourceLimited = false,
): SessionsHistoryPage {
  const enabled = loadRuntimeConfig().providerSettings;
  const sorted = all
    .filter((session) => enabled[session.agent as keyof typeof enabled] !== false)
    .sort((left, right) =>
      right.lastActivityAt - left.lastActivityAt
      || left.agent.localeCompare(right.agent)
      || left.sessionId.localeCompare(right.sessionId)
    );
  const listed = query.startedBy ? startedRuns(sorted, query.startedBy) : sorted;
  const anchor = query.cursor
    ? listed.findIndex((session) => cursorFor(session) === query.cursor)
    : -1;
  const resetRequired = Boolean(query.cursor && anchor < 0);
  const start = query.cursor ? anchor + 1 : 0;
  const sessions = resetRequired ? [] : listed.slice(start, start + query.limit);
  const hasMore = !resetRequired && start + sessions.length < listed.length;
  return {
    type: "sessions.history.page",
    requestId: query.requestId,
    sessions,
    ...(hasMore && sessions.length ? { nextCursor: cursorFor(sessions[sessions.length - 1]!) } : {}),
    hasMore,
    ...(sourceLimited ? { sourceLimited: true } : {}),
    ...(resetRequired ? { resetRequired: true } : {}),
    generatedAt: Date.now(),
  };
}

let archiveScanLimit = MAX_FILES;

export async function publishHistoryPage(client: RelayClient, query: SessionsHistoryQuery): Promise<void> {
  // A chat's earlier runs are read from the catalog's own window: a run older than that is counted on its
  // parent, and a tap on the phone does not make the computer read every transcript it has.
  if (query.startedBy) {
    const scan = await scanSessionHistoryForPagingCooperatively();
    await client.send(historyPage(query, scan.sessions, scan.sourceLimited), "phone", { ttlMs: 60_000 });
    return;
  }
  for (;;) {
    const scan = scanSessionHistoryForPaging(archiveScanLimit);
    const page = historyPage(query, scan.sessions, scan.sourceLimited);
    if (!scan.sourceLimited || (page.hasMore && !page.resetRequired)) {
      await client.send(page, "phone", { ttlMs: 60_000 });
      return;
    }
    archiveScanLimit = Math.min(archiveScanLimit * 2, Number.MAX_SAFE_INTEGER - 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
