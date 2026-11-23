import assert from "node:assert/strict";
import test from "node:test";
import { historyPage } from "../../apps/bridge/src/monitor/history/pages";
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

test("the same native session id in two providers keeps both History rows", () => {
  const first = session(1);
  const second = { ...first, agent: "claude" as const };
  const page = historyPage({ ...query(), limit: 1 }, [first, second]);
  assert.equal(page.hasMore, true);
  const next = historyPage({ ...query(page.nextCursor), limit: 1 }, [first, second]);
  assert.equal(next.resetRequired, undefined);
  assert.notEqual(page.sessions[0]?.agent, next.sessions[0]?.agent);
  assert.equal(next.hasMore, false);
});

test("a chat's earlier runs come in pages of their own, with the runs they started in turn", () => {
  // A chat that ran 45 headless runs is published with its newest three; the phone asks for the rest by the chat's id.
  const parent = { ...session(500), sessionId: "parent-chat", agent: "claude" as const };
  const runs = Array.from({ length: 45 }, (_, index) => ({ ...session(index),
    startedBy: { agent: "claude" as const, sessionId: "parent-chat" } }));
  const nested = { ...session(46), sessionId: "nested-run",
    startedBy: { agent: "codex" as const, sessionId: runs[0]!.sessionId } };
  const stranger = { ...session(47), sessionId: "someone-else",
    startedBy: { agent: "claude" as const, sessionId: "another-chat" } };
  const all = [parent, ...runs, nested, stranger, session(48)];
  const ask = (cursor?: string): SessionsHistoryQuery => ({ ...query(cursor), limit: 20, startedBy: ["parent-chat"] });
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 3; count += 1) {
    const page = historyPage(ask(cursor), all);
    assert.equal(Payload.safeParse(page).success, true);
    seen.push(...page.sessions.map((item) => item.sessionId));
    assert.equal(page.hasMore, count < 2);
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 46, "every run of the chat and the run one of them started");
  assert.equal(seen[0], "nested-run", "newest first");
  assert.ok(!seen.includes("parent-chat"), "the chat itself is the phone's already");
  assert.ok(!seen.includes("someone-else") && !seen.includes("session-048"), "nothing another chat started, nothing else");
});

test("an earlier-runs query is checked like any other phone request", () => {
  assert.equal(Payload.safeParse({ ...query(), startedBy: ["parent-chat"] }).success, true);
  assert.equal(Payload.safeParse({ ...query(), startedBy: [] }).success, false);
  assert.equal(Payload.safeParse({ ...query(), startedBy: ["../../etc"] }).success, false);
  assert.equal(Payload.safeParse({ ...query(), startedBy: Array.from({ length: 65 }, (_, i) => `chat-${1000 + i}`) }).success, false);
});
