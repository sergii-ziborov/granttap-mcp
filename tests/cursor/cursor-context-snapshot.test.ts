import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanCursor } from "../../apps/bridge/src/sessions/cursor/scan";

test("Cursor current context may shrink while lifetime usage keeps growing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-cursor-context-"));
  const db = join(root, "state.vscdb");
  const logs = join(root, "logs", "session");
  mkdirSync(logs, { recursive: true });
  execFileSync("sqlite3", [db, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);"]);
  const composer = JSON.stringify({ composerId: "session", name: "Work", createdAt: Date.now() - 1000,
    lastUpdatedAt: Date.now(), contextTokensUsed: 40 });
  execFileSync("sqlite3", [db, `INSERT INTO cursorDiskKV VALUES('composerData:session', '${composer}');`]);
  const unknown = JSON.stringify({ composerId: "without-native-context", name: "Unknown context",
    createdAt: Date.now() - 1000, lastUpdatedAt: Date.now() });
  execFileSync("sqlite3", [db,
    `INSERT INTO cursorDiskKV VALUES('composerData:without-native-context', '${unknown}');`]);
  writeFileSync(join(logs, "session.jsonl"), [
    { role: "assistant", timestamp: new Date().toISOString(),
      message: { usage: { input_tokens: 100, output_tokens: 5 }, content: "Earlier work" } },
    { role: "assistant", timestamp: new Date().toISOString(),
      message: { usage: { input_tokens: 50, output_tokens: 5 }, content: "After compact" } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const other = join(root, "logs", "without-native-context");
  mkdirSync(other);
  writeFileSync(join(other, "without-native-context.jsonl"), JSON.stringify({
    role: "assistant", timestamp: new Date().toISOString(),
    message: { usage: { input_tokens: 100, output_tokens: 5 }, content: "Work" },
  }));
  const priorDb = process.env.GRANTTAP_CURSOR_STATE_DB;
  const priorLogs = process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR;
  process.env.GRANTTAP_CURSOR_STATE_DB = db;
  process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR = join(root, "logs");
  t.after(() => {
    if (priorDb == null) delete process.env.GRANTTAP_CURSOR_STATE_DB;
    else process.env.GRANTTAP_CURSOR_STATE_DB = priorDb;
    if (priorLogs == null) delete process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR;
    else process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR = priorLogs;
  });
  const sessions = scanCursor().sessions;
  const session = sessions.find((item) => item.sessionId === "session");
  assert.equal(session?.tokensSession, 160);
  assert.equal(session?.contextTokensUsed, 40);
  const withoutSnapshot = sessions.find((item) => item.sessionId === "without-native-context");
  assert.equal(withoutSnapshot?.tokensSession, 105);
  assert.equal(withoutSnapshot?.contextTokensUsed, undefined);
});
