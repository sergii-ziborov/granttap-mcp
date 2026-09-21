import assert from "node:assert/strict";
import test from "node:test";
import { historyPage } from "../../apps/bridge/src/monitor/handlers/history-pages";
import { Payload, type SessionInfo, type SessionsHistoryQuery } from "../../packages/protocol/schema";

const requestId = "00000000-0000-4000-8000-000000000001";
const query = (cursor?: string): SessionsHistoryQuery => ({
  type: "sessions.history.query", requestId, cursor, limit: 40, createdAt: 1,
});
const session = (index: number): SessionInfo => ({
  sessionId: `session-${String(index).padStart(3, "0")}`, agent: "codex",
  state: "idle", startedAt: index, lastActivityAt: index,
  tokensSession: 0, tokensLastTurn: 0,
});

test("history pages cover more than the published catalog without duplicate rows", () => {
  const all = Array.from({ length: 95 }, (_, index) => session(index));
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 3; count += 1) {
    const page = historyPage(query(cursor), all);
    assert.equal(Payload.safeParse(page).success, true);
    seen.push(...page.sessions.map((item) => item.sessionId));
    assert.equal(page.hasMore, count < 2);
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 95);
  assert.equal(new Set(seen).size, 95);
  assert.equal(seen[0], "session-094");
  assert.equal(seen[94], "session-000");
});

test("history pagination rejects an unknown anchor with an explicit reset", () => {
  const page = historyPage(query("obsolete-cursor"), [session(1)]);
  assert.equal(page.resetRequired, true);
  assert.deepEqual(page.sessions, []);
  assert.equal(page.hasMore, false);
});

test("a capped provider scan reports an incomplete historical source", () => {
  const page = historyPage(query(), [session(1)], true);
  assert.equal(page.hasMore, false);
  assert.equal(page.sourceLimited, true);
});
