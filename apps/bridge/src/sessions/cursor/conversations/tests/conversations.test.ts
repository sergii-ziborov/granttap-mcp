import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RelayClient } from "../../../../../../../packages/core/relay-client";
import type { SessionActivity, SessionInfo } from "../../../../../../../packages/protocol/schema";
import { publishSessionEvents } from "../../../../monitor/handlers/catalog";
import { readTranscriptHistory } from "../../../../transcript-history";
import { beginCursorTurn, cursorConversationHistory, cursorConversationSession, mergeCursorConversations } from "..";
import { archivePath, readConversation, recordPath } from "../storage";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-cursor-visible-"));
  const env = { GRANTTAP_CONFIG_DIR: root, GRANTTAP_CURSOR_TRANSCRIPTS_DIR: join(root, "no-native-logs"),
    GRANTTAP_CURSOR_STATE_DB: join(root, "missing.db") };
  const prior = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of prior) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } rmSync(root, { recursive: true, force: true }); });
  const session: SessionInfo = { sessionId: "visible-task", cwd: join(root, "workspace"), agent: "cursor",
    state: "idle", startedAt: 1, lastActivityAt: 1, tokensSession: 12, tokensLastTurn: 3, title: "Original Task" };
  return { root, session, start: (text = "Visible user request") => beginCursorTurn({
    sessionId: session.sessionId, cwd: session.cwd!, session, text }) };
}

test("visible Cursor messages survive a fresh reader process and retain original Task metadata", t => {
  const f = fixture(t), turn = f.start(); turn.update("Visible answer"); turn.finish();
  const saved = cursorConversationSession(f.session.sessionId)!;
  assert.equal(saved.title, "Original Task"); assert.equal(saved.state, "idle");
  assert.equal(lstatSync(recordPath(saved.sessionId)).mode & 0o777, 0o600);
  assert.equal(lstatSync(archivePath(saved.sessionId)).mode & 0o777, 0o600);
  const script = `import {cursorConversationSession,cursorConversationHistory} from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
    const session=cursorConversationSession('visible-task');
    console.log(JSON.stringify(cursorConversationHistory(session).entries.map(row=>row.text)));`;
  const text = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", env: process.env });
  assert.deepEqual(JSON.parse(text), ["Visible user request", "Visible answer"]);
  const native = { ...f.session, tokensSession: 123, tokensLastTurn: 17 };
  const merged = mergeCursorConversations([native]);
  assert.equal(merged.length, 1); assert.equal(merged[0]!.tokensSession, 123);
  assert.equal(merged[0]!.title, "Original Task");
});

test("a partial answer remains readable while waiting and finalization does not duplicate it", async t => {
  const f = fixture(t), turn = f.start(); turn.state("waiting");
  assert.equal(readConversation(f.session.sessionId)!.session.state, "waiting");
  turn.state("working"); turn.update("Partial"); await delay(500);
  assert.equal(cursorConversationHistory(f.session)!.entries.at(-1)!.text, "Partial");
  turn.update("Partial, then complete"); turn.finish(); turn.finish(); turn.update("Too late"); turn.state("waiting");
  const page = readTranscriptHistory(cursorConversationSession(f.session.sessionId)!)!;
  assert.equal(page.entries.length, 2); assert.equal(page.entries.at(-1)!.text, "Partial, then complete");
  assert.equal(page.state, "idle");
});

test("a late previous turn cannot overwrite the next turn or another workspace", t => {
  const f = fixture(t), first = f.start("First"), second = f.start("Second");
  first.update("Stale answer"); first.finish("Stale failure"); second.update("Current answer"); second.finish();
  const text = JSON.stringify(cursorConversationHistory(f.session));
  assert(!text.includes("Stale")); assert(text.includes("Current answer"));
  assert.throws(() => beginCursorTurn({ sessionId: f.session.sessionId, cwd: join(f.root, "other"), text: "Wrong" }));
  assert.equal(cursorConversationHistory({ ...f.session, cwd: join(f.root, "other") }), undefined);
  assert.equal(cursorConversationSession("unrelated-task"), undefined);
});

test("Cursor history pages remain Task-bound and stable when new turns arrive", t => {
  const f = fixture(t);
  for (let i = 0; i < 85; i++) { const turn = f.start(`Request ${i}`); turn.update(`Answer ${i}`); turn.finish(); }
  const first = cursorConversationHistory(f.session)!;
  assert.equal(first.entries.length, 80); assert(first.history!.hasMore);
  const cursor = first.history!.cursor!;
  const older = cursorConversationHistory(f.session, cursor)!;
  assert.equal(older.entries.length, 80); assert.equal(older.history!.requestedCursor, cursor);
  const late = f.start("Later request"); late.update("Later answer"); late.finish();
  assert.deepEqual(cursorConversationHistory(f.session, cursor)!.entries, older.entries);
  const all = [...first.entries]; let page = older;
  for (let i = 0; i < 4; i++) {
    all.push(...page.entries); if (!page.history?.hasMore) break;
    page = cursorConversationHistory(f.session, page.history.cursor)!;
  }
  assert.equal(new Set(all.map(row => row.id)).size, 170);
  assert.equal(cursorConversationHistory(f.session, "malformed"), undefined);
  const other: SessionInfo = { ...f.session, sessionId: "other-task" };
  const turn = beginCursorTurn({ sessionId: other.sessionId, cwd: other.cwd!, text: "Other" }); turn.finish();
  assert.equal(cursorConversationHistory(other, cursor), undefined);
});

test("the computer returns a fresh Cursor transcript even before the published catalog catches up", async t => {
  const f = fixture(t), turn = f.start(); turn.update("Fresh answer"); turn.finish();
  const sent: SessionActivity[] = [];
  const client = { room: "fixture", setSessionKey() {}, async send() {},
    async sendSession(payload: SessionActivity) { sent.push(payload); } } as unknown as RelayClient;
  assert(await publishSessionEvents(client, f.session.sessionId, { type: "sessions.status", machine: "Fixture",
    sessions: [], generatedAt: 1 }, undefined, { history: true }));
  assert(sent[0]!.entries.some(row => row.text === "Fresh answer"));
  assert.equal(sent[0]!.sessionId, f.session.sessionId);
});

test("invalid records and symlink archives never expose a foreign file", t => {
  const f = fixture(t), turn = f.start(); turn.finish("Stopped for this Task");
  const path = archivePath(f.session.sessionId);
  appendFileSync(path, "not JSON\n");
  assert(cursorConversationHistory(f.session)!.entries.some(row => row.text === "Stopped for this Task"));
  const foreign = join(f.root, "foreign"); writeFileSync(foreign, "private foreign content");
  rmSync(path); symlinkSync(foreign, path);
  assert.equal(cursorConversationHistory(f.session), undefined);
  assert.throws(() => f.start("Must not append outside the private archive"));
  assert.equal(readFileSync(foreign, "utf8"), "private foreign content");
  writeFileSync(recordPath(f.session.sessionId), "{}");
  assert.equal(cursorConversationSession(f.session.sessionId), undefined);
  assert.deepEqual(mergeCursorConversations([]), []);
});
