import type {
  SessionInfo, SessionsHistoryPage, SessionsHistoryQuery,
} from "../../../../../packages/protocol/schema";
import { scanSessionHistoryForPaging } from "../../sessions";
import { MAX_FILES } from "../../sessions/support/common";
import { loadRuntimeConfig } from "../../config";
import type { RelayClient } from "../../../../../packages/core/relay-client";

function cursorFor(session: SessionInfo): string {
  return Buffer.from(JSON.stringify([session.lastActivityAt, session.agent, session.sessionId]))
    .toString("base64url");
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
  const anchor = query.cursor
    ? sorted.findIndex((session) => cursorFor(session) === query.cursor)
    : -1;
  const resetRequired = Boolean(query.cursor && anchor < 0);
  const start = query.cursor ? anchor + 1 : 0;
  const sessions = resetRequired ? [] : sorted.slice(start, start + query.limit);
  const hasMore = !resetRequired && start + sessions.length < sorted.length;
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
