import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cursorTokenHours, scanCursor } from "../../apps/bridge/src/sessions/cursor";
import { HOUR_MS, hourStart, tokenUsageOf } from "../../apps/bridge/src/sessions/token-usage";

test("Cursor counts what tokensSession counts per hour, subagents included, and undated rows at the last activity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-cursor-token-hours-"));
  const logs = join(root, "logs");
  const conversation = join(logs, "cursor-chat");
  mkdirSync(join(conversation, "subagents"), { recursive: true });
  const earlier = Date.now() - 3 * HOUR_MS;
  writeFileSync(join(conversation, "cursor-chat.jsonl"), [
    { role: "user", message: { content: [{ type: "text", text: "Synthetic request" }] } },
    { role: "assistant", timestamp: new Date(earlier).toISOString(), model: "cursor-model",
      message: { usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20 }, content: "Answer" } },
    { role: "assistant", message: { usage: { input_tokens: 7, output_tokens: 3 }, content: "Undated answer" } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  writeFileSync(join(conversation, "subagents", "helper.jsonl"), JSON.stringify({
    role: "assistant", timestamp: new Date(earlier).toISOString(),
    message: { model: "cursor-fast", usage: { input_tokens: 40, output_tokens: 2 }, content: "Subagent answer" },
  }));
  const previous = { db: process.env.GRANTTAP_CURSOR_STATE_DB, logs: process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR };
  process.env.GRANTTAP_CURSOR_STATE_DB = join(root, "missing.vscdb");
  process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR = logs;
  t.after(() => {
    for (const [key, value] of [["GRANTTAP_CURSOR_STATE_DB", previous.db], ["GRANTTAP_CURSOR_TRANSCRIPTS_DIR", previous.logs]] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const session = scanCursor().sessions.find((item) => item.sessionId === "cursor-chat")!;
  const hours = cursorTokenHours("cursor-chat");
  assert.ok(session.tokensSession > 125 + 10 + 42, "the request's own estimate counts too");
  assert.equal(hours.reduce((sum, row) => sum + row.tokens, 0), session.tokensSession);
  assert.deepEqual(hours.filter((row) => row.startedAt != null), [
    { startedAt: hourStart(earlier), model: "cursor-model", tokens: 125 },
    { startedAt: hourStart(earlier), model: "cursor-fast", tokens: 42 },
  ]);
  const usage = tokenUsageOf([{ agent: "cursor", sessionId: session.sessionId, model: session.model,
    lastActivityAt: session.lastActivityAt, hours }]);
  assert.equal(usage.windows[0]!.tokens, session.tokensSession);
  assert.equal(usage.hours.find((hour) => hour.startedAt === hourStart(session.lastActivityAt))?.tokens,
    session.tokensSession - 125 - 42, "rows without a time count at the chat's last activity");
});
