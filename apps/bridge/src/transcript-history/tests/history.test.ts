import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { codexLogPathBySession, codexLogPathForSession } from "../../sessions/scan/codex/shared";
import { readTranscriptHistory } from "../index";
import type { SessionInfo } from "../../../../../packages/protocol/schema";

const session: SessionInfo = { sessionId: "history-test", agent: "codex", state: "idle",
  startedAt: 1, lastActivityAt: 100, tokensSession: 0, tokensLastTurn: 0 };

test("native history finds a known session by date and ID without a catalog scan", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-direct-history-"));
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const startedAt = Date.parse("2026-10-08T23:59:00Z");
  const day = join(root, "2026", "10", "09");
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-09T00-00-00-${sessionId}.jsonl`);
  writeFileSync(path, JSON.stringify({ timestamp: "2026-10-08T23:59:00Z", type: "event_msg",
    payload: { type: "user_message", message: "Earlier request" } }) + "\n");
  const previousRoot = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previousRoot;
    codexLogPathBySession.delete(sessionId);
    rmSync(root, { recursive: true });
  });
  codexLogPathBySession.set(sessionId, join(root, "missing.jsonl"));
  assert.equal(codexLogPathForSession(sessionId, startedAt), path);
  codexLogPathBySession.delete(sessionId);
  assert.equal(readTranscriptHistory({ ...session, sessionId, startedAt })?.entries[0]?.text,
    "Earlier request");
  assert.equal(codexLogPathForSession("../escape", startedAt), undefined);
});

test("native history pages retain repeated user turns, stable ids and earlier context", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-history-"));
  t.after(() => { codexLogPathBySession.delete(session.sessionId); rmSync(root, { recursive: true }); });
  const path = join(root, "rollout.jsonl");
  const rows = Array.from({ length: 125 }, (_, i) => JSON.stringify({
    timestamp: new Date(1_000 + i).toISOString(), type: "event_msg",
    payload: { type: i % 5 === 0 ? "user_message" : "agent_message", message: i % 5 === 0 ? "Continue" : `Reply ${i}` },
  }));
  writeFileSync(path, rows.join("\n") + "\n");
  codexLogPathBySession.set(session.sessionId, path);
  let page = readTranscriptHistory(session);
  assert.ok(page?.history?.hasMore);
  const seen = new Set<string>();
  const texts: string[] = [];
  for (let attempt = 0; page && attempt < 10; attempt++) {
    for (const entry of page.entries) { assert.ok(!seen.has(entry.id)); seen.add(entry.id); texts.push(entry.text); }
    if (!page.history?.hasMore) break;
    const cursor = page.history.cursor;
    const repeat = readTranscriptHistory(session, cursor);
    page = readTranscriptHistory(session, cursor);
    assert.deepEqual(page?.entries, repeat?.entries);
    assert.deepEqual(page?.history, repeat?.history);
  }
  assert.equal(seen.size, 125);
  assert.equal(texts.filter((text) => text === "Continue").length, 25);
  assert.equal(page?.history?.hasMore, false);
  assert.equal(readTranscriptHistory({ ...session, sessionId: "other" }, "invalid"), undefined);
  assert.equal(readTranscriptHistory(session, "invalid"), undefined);
});

test("the final reply carries edits outside the visible history page", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-history-"));
  t.after(() => { codexLogPathBySession.delete(session.sessionId); rmSync(root, { recursive: true }); });
  const path = join(root, "rollout.jsonl");
  const row = (i: number, payload: unknown, type = "event_msg") => JSON.stringify({
    timestamp: new Date(1_000 + i).toISOString(), type, payload });
  const rows = [row(0, { type: "task_started", turn_id: "turn" }),
    row(1, { type: "user_message", message: "Edit the files" }),
    row(2, { type: "item_completed", turn_id: "turn", item: { type: "FileChange", id: "edit", status: "completed",
      changes: { "/repo/early.ts": { type: "add", content: "first\nsecond\n" } } } }),
    row(3, { type: "ignored", data: "x".repeat(4 * 1024 * 1024) }),
    ...Array.from({ length: 90 }, (_, i) => row(10 + i, { type: "agent_message", message: `Progress ${i}` })),
    row(101, { type: "item_completed", turn_id: "turn", item: { type: "AgentMessage", id: "answer", phase: "final_answer" } }),
    row(102, { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done" }] }, "response_item")];
  writeFileSync(path, rows.join("\n") + "\n");
  codexLogPathBySession.set(session.sessionId, path);
  const page = readTranscriptHistory(session);
  const final = page?.entries.find((entry) => entry.kind === "final");
  assert.deepEqual(final?.fileChanges?.map((file) => [file.path, file.linesAdded]), [["/repo/early.ts", 2]]);
  assert.equal(final?.fileChangesComplete, true);
  assert.ok(!page?.entries.some((entry) => entry.id.endsWith(":edit")));
});

test("a large completed native file batch is explicitly partial", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-history-batch-"));
  t.after(() => { codexLogPathBySession.delete(session.sessionId); rmSync(root, { recursive: true }); });
  const path = join(root, "rollout.jsonl");
  const changes = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`/repo/file-${i}.ts`, { type: "add", content: "created" }]));
  const payloads = [
    { type: "user_message", message: "Edit files" },
    { type: "item_completed", item: { type: "FileChange", id: "edit", status: "completed", changes } },
    { type: "agent_message", message: "Done", phase: "final_answer" },
  ];
  writeFileSync(path, payloads.map((payload, i) => JSON.stringify({ type: "event_msg", payload,
    timestamp: new Date(1000 + i).toISOString() })).join("\n") + "\n");
  codexLogPathBySession.set(session.sessionId, path);
  const final = readTranscriptHistory(session)?.entries.find((entry) => entry.kind === "final");
  assert.equal(final?.fileChanges?.length, 64);
  assert.equal(final?.fileChangesComplete, false);
});
