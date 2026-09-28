import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopTaskActivityRunner } from "../../../apps/mcp/src/desktop/task-activity-runner";
import { desktopUsageSessions } from "../../../apps/mcp/src/desktop/projection/session-usage";
import type { SessionInfo } from "../../../packages/protocol/schema";

test("desktop usage includes observed token totals without conversation content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-usage-sessions-"));
  const logs = join(root, "sessions");
  await mkdir(logs);
  const previous = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = logs;
  const worker = new DesktopTaskActivityRunner();
  t.after(async () => {
    worker.close();
    if (previous === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const now = Date.now() - 5_000;
  await writeFile(join(logs, "rollout-test.jsonl"), [
    { type: "session_meta", timestamp: now, payload: { id: "usage-test", cwd: root } },
    { type: "event_msg", timestamp: now + 1, payload: {
      type: "user_message", message: "PRIVATE_USAGE_PROMPT",
    } },
    { type: "event_msg", timestamp: now + 2, payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
      last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      model_context_window: 200000,
    } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const result = await worker.usage() as { sessions?: Array<{
    sessionId: string; agent: string; tokensSession: number; tokensLastTurn: number;
  }> };
  const session = result?.sessions?.find(row => row.sessionId === "usage-test" && row.agent === "codex");
  assert.equal(session?.tokensSession, 1200);
  assert.equal(session?.tokensLastTurn, 120);
  assert.doesNotMatch(JSON.stringify(result.sessions), /PRIVATE_USAGE_PROMPT|cwd|title|summary/);
});

test("native usage keeps providers separate and bounds the newest session catalog", () => {
  const session = (sessionId: string, agent: SessionInfo["agent"], at: number,
    tokensSession = 10): SessionInfo => ({
    sessionId, agent, state: "idle", startedAt: 0, lastActivityAt: at,
    tokensSession, tokensLastTurn: 2,
  });
  const rows = desktopUsageSessions([
    session("same", "codex", 1, 10), session("same", "codex", 5, 50),
    session("same", "claude", 2, 20),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.agent, "codex");
  assert.equal(rows[0]?.tokensSession, 50);
  assert.equal(rows[1]?.tokensSession, 20);
  assert.equal(desktopUsageSessions([]).length, 0);
  const bounded = desktopUsageSessions(Array.from({ length: 600 }, (_, index) =>
    session(`s-${index}`, "codex", index)));
  assert.equal(bounded.length, 512);
  assert.equal(bounded[0]?.sessionId, "s-599");
  assert.equal(bounded.at(-1)?.sessionId, "s-88");
});
