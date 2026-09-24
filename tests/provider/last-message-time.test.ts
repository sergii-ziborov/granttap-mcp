import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCodexFile } from "../../apps/bridge/src/sessions/scan/codex/parse";
import { parseClaudeFile } from "../../apps/bridge/src/sessions/scan/claude/parse";
import { scanGrok } from "../../apps/bridge/src/sessions/scan/grok";
import { transcriptSummary, type CursorLogFile } from "../../apps/bridge/src/sessions/cursor/transcripts";

function writeLog(path: string, rows: unknown[], modifiedAt: number): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  utimesSync(path, new Date(modifiedAt), new Date(modifiedAt));
}

test("chat timestamps come from visible messages, not later file sync or metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-message-time-"));
  const now = Date.now();
  const first = now - 86_400_000;
  const last = first + 60_000;
  const metadata = last + 30_000;
  const oldGrokRoot = process.env.GRANTTAP_GROK_SESSIONS_DIR;
  try {
    const codexFile = join(directory, "codex.jsonl");
    writeLog(codexFile, [
      { type: "session_meta", timestamp: new Date(first).toISOString(), payload: { id: "codex-message-time" } },
      { type: "event_msg", timestamp: new Date(last).toISOString(), payload: { type: "user_message", message: "Hello" } },
      { type: "event_msg", timestamp: new Date(metadata).toISOString(), payload: { type: "token_count", info: {} } },
    ], now);
    const codex = parseCodexFile(codexFile)?.session;
    assert.equal(codex?.lastMessageAt, last);
    assert.ok((codex?.lastActivityAt ?? 0) > last);

    const claudeFile = join(directory, "claude.jsonl");
    writeLog(claudeFile, [
      { sessionId: "claude-message-time", type: "user", timestamp: new Date(first).toISOString(), message: { role: "user", content: "Hello" } },
      { sessionId: "claude-message-time", type: "assistant", timestamp: new Date(last).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
      { sessionId: "claude-message-time", type: "progress", timestamp: new Date(metadata).toISOString() },
    ], now);
    const claude = parseClaudeFile(claudeFile)?.session;
    assert.equal(claude?.lastMessageAt, last);
    assert.ok((claude?.lastActivityAt ?? 0) > last);

    const cursorFile = join(directory, "cursor.jsonl");
    writeLog(cursorFile, [
      { role: "user", timestamp: new Date(first).toISOString(), message: { content: "Hello" } },
      { role: "assistant", timestamp: new Date(last).toISOString(), message: { content: [{ type: "text", text: "Hi" }] } },
      { role: "tool", timestamp: new Date(metadata).toISOString(), message: { content: "saved" } },
    ], now);
    const file: CursorLogFile = {
      path: cursorFile, mtimeMs: now, birthtimeMs: first, size: 1, isSubagent: false,
    };
    const cursor = transcriptSummary("cursor-message-time", [file]);
    assert.equal(cursor.lastMessageAt, last);
    assert.ok(cursor.lastActivityAt > last);

    const grokRoot = join(directory, "grok");
    const grokSession = join(grokRoot, "grok-message-time");
    mkdirSync(grokSession, { recursive: true });
    const summaryFile = join(grokSession, "summary.json");
    writeFileSync(summaryFile, JSON.stringify({
      info: { id: "grok-message-time" }, created_at: new Date(first).toISOString(),
      updated_at: new Date(metadata).toISOString(),
    }));
    utimesSync(summaryFile, new Date(now), new Date(now));
    writeLog(join(grokSession, "chat_history.jsonl"), [
      { role: "user", timestamp: new Date(first).toISOString(), content: "Hello" },
      { role: "assistant", timestamp: new Date(last).toISOString(), content: "Hi" },
      { role: "system", timestamp: new Date(metadata).toISOString(), content: "Indexed" },
    ], now);
    process.env.GRANTTAP_GROK_SESSIONS_DIR = grokRoot;
    const grok = scanGrok().sessions.find((item) => item.sessionId === "grok-message-time");
    assert.equal(grok?.lastMessageAt, last);
    assert.ok((grok?.lastActivityAt ?? 0) > last);
  } finally {
    if (oldGrokRoot === undefined) delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    else process.env.GRANTTAP_GROK_SESSIONS_DIR = oldGrokRoot;
    rmSync(directory, { recursive: true, force: true });
  }
});
