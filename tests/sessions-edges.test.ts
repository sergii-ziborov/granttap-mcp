import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityUsageStatus, SessionInfo } from "../packages/protocol/schema";
import {
  scanCapabilityUsage,
  scanSessionActivity,
  scanSessionHistory,
  scanSessions,
  scopeCapabilityUsageToRoom,
} from "../apps/bridge/src/sessions";

test("session catalog reserves bounded rows and retains an older capability activity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-session-edges-"));
  const claude = join(root, "claude", "project");
  const codex = join(root, "codex");
  await Promise.all([mkdir(claude, { recursive: true }), mkdir(codex)]);
  const now = Date.now();
  for (let index = 0; index < 45; index += 1) {
    const id = `bounded-${index}`;
    const rows: unknown[] = [{
      sessionId: id, cwd: root, timestamp: now + index, type: "user",
      message: { role: "user", content: `Task ${index}` },
    }];
    if (index === 44) {
      rows.push({
        sessionId: id, cwd: root, timestamp: now + 100, type: "assistant",
        message: { role: "assistant", content: [{
          type: "tool_use", id: "older-mcp", name: "mcp__github__issue", input: { issue: 3 },
        }] },
      });
      for (let message = 0; message < 30; message += 1) rows.push({
        sessionId: id, timestamp: now + 200 + message, type: "assistant",
        message: { role: "assistant", content: `Update ${message}` },
      });
    }
    await writeFile(join(claude, `${id}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  const previousClaude = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  const previousCodex = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = join(root, "claude");
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = codex;
  t.after(() => {
    if (previousClaude == null) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = previousClaude;
    if (previousCodex == null) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previousCodex;
  });

  const live = scanSessions();
  assert.equal(live.sessions.length, 40);
  assert.equal(scanSessionHistory().length, 45);
  const rich = live.sessions.find((session) => session.sessionId === "bounded-44")!;
  const activity = scanSessionActivity(rich);
  assert.equal(activity.entries.some((entry) => entry.mcpServer === "github"), true);
  assert.equal(activity.entries.length > 24, true);
});

test("unknown providers stay empty and room scoping rejects unsafe identifiers", () => {
  const unknown: SessionInfo = {
    sessionId: "unknown", agent: "other" as never, state: "idle",
    startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0,
  };
  assert.deepEqual(scanSessionActivity(unknown).entries, []);
  assert.deepEqual(scanCapabilityUsage([unknown]).events, []);
  const status: CapabilityUsageStatus = {
    type: "capability.usage.status", generatedAt: 1,
    events: [{
      sourceId: "valid", sessionId: " task ", kind: "cli",
      name: "git", toolName: "exec", outcome: "success", createdAt: 1,
    }, {
      sourceId: "invalid", sessionId: " ", kind: "cli",
      name: "git", toolName: "exec", outcome: "success", createdAt: 1,
    }],
  };
  assert.throws(() => scopeCapabilityUsageToRoom(status, " "), /invalid capability/);
  assert.throws(() => scopeCapabilityUsageToRoom(status, "x".repeat(257)), /invalid capability/);
  const scoped = scopeCapabilityUsageToRoom(status, " room ");
  assert.equal(scoped.events.length, 1);
  assert.equal(scoped.events[0]?.sessionId, "task");
  assert.equal(scoped.events[0]?.roomId, "room");
});
