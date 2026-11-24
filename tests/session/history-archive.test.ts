import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessionHistoryForPaging } from "../../apps/bridge/src/sessions";
import { historyPage, publishHistoryPage } from "../../apps/bridge/src/monitor/history/pages";
import type { RelayClient } from "../../packages/core/relay-client";
import type { SessionsHistoryPage } from "../../packages/protocol/schema";

test("History reaches older native chats beyond the live catalog scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-history-archive-"));
  const previous = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = root;
  try {
    const now = Date.now();
    for (let index = 0; index < 205; index += 1) {
      const id = `archive-${String(index).padStart(3, "0")}`;
      const path = join(root, `${id}.jsonl`);
      await writeFile(path, `${JSON.stringify({
        type: "session_meta", timestamp: now - index * 1_000,
        payload: { id, cwd: root },
      })}\n${JSON.stringify({ type: "event_msg", timestamp: now - index * 1_000,
        payload: { type: "user_message", message: "Archive fixture." } })}\n`);
      const time = new Date(now - index * 1_000);
      await utimes(path, time, time);
    }
    const first = scanSessionHistoryForPaging(200);
    assert.equal(first.sessions.length, 200);
    assert.equal(first.sourceLimited, true);
    const expanded = scanSessionHistoryForPaging(400);
    assert.equal(expanded.sessions.length, 205);
    assert.equal(expanded.sourceLimited, false);
    const nearEnd = historyPage({
      type: "sessions.history.query", requestId: "00000000-0000-4000-8000-000000000001",
      limit: 199, createdAt: 1,
    }, first.sessions);
    let delivered: SessionsHistoryPage | undefined;
    await publishHistoryPage({
      send: async (payload: unknown) => { delivered = payload as SessionsHistoryPage; },
    } as unknown as RelayClient, {
      type: "sessions.history.query", requestId: "00000000-0000-4000-8000-000000000001",
      cursor: nearEnd.nextCursor, limit: 40, createdAt: 1,
    });
    assert.equal(delivered?.sessions.length, 6);
    assert.equal(delivered?.sessions.at(-1)?.sessionId, "archive-204");
    assert.equal(delivered?.hasMore, false);
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = historyPage({
        type: "sessions.history.query", requestId: "00000000-0000-4000-8000-000000000001",
        cursor, limit: 40, createdAt: 1,
      }, expanded.sessions);
      for (const session of page.sessions) seen.add(session.sessionId);
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.size, 205);
    assert.ok(seen.has("archive-204"));
  } finally {
    if (previous == null) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a chat's earlier runs are read without holding the monitor", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-history-started-"));
  const previous = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = root;
  try {
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      const id = `started-${index}`;
      await writeFile(join(root, `${id}.jsonl`), `${JSON.stringify({
        type: "session_meta", timestamp: now - index * 1_000, payload: { id, cwd: root },
      })}\n`);
    }
    const order: string[] = [];
    let delivered: SessionsHistoryPage | undefined;
    setImmediate(() => order.push("other monitor work"));
    await publishHistoryPage({
      send: async (payload: unknown) => { delivered = payload as SessionsHistoryPage; order.push("page"); },
    } as unknown as RelayClient, {
      type: "sessions.history.query", requestId: "00000000-0000-4000-8000-000000000002",
      limit: 20, startedBy: ["parent-chat"], createdAt: 1,
    });
    // Read at once, a cold window held the monitor for 50 s on a real computer; nothing else ran meanwhile.
    assert.deepEqual(order, ["other monitor work", "page"]);
    assert.equal(delivered?.requestId, "00000000-0000-4000-8000-000000000002");
    assert.deepEqual(delivered?.sessions, [], "none of these runs was started by the chat asked about");
    assert.equal(delivered?.hasMore, false);
  } finally {
    if (previous === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
