import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionInfo } from "../packages/protocol/schema";
import { aggregateChildThreads } from "../apps/bridge/src/sessions/child-threads";
import {
  claudeActivity,
  claudeCapabilityUsage,
  scanClaude,
} from "../apps/bridge/src/sessions/claude";
import {
  codexActivity,
  codexCapabilityUsage,
  scanCodex,
} from "../apps/bridge/src/sessions/codex";
import {
  cursorActivity,
  cursorRootSessionId,
  scanCursor,
} from "../apps/bridge/src/sessions/cursor";
import { copilotActivity, scanCopilot } from "../apps/bridge/src/sessions/copilot";

function setEnv(t: test.TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  });
}

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test("Claude sidechains stay inside their root chat and normalize capability usage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-agentic-claude-"));
  const project = join(root, "project");
  const sessionId = "claude-root";
  const childId = "claude-child";
  const childDir = join(project, sessionId, "subagents");
  await mkdir(childDir, { recursive: true });
  const started = Date.now() - 5_000;
  await writeFile(join(project, `${sessionId}.jsonl`), jsonl([
    {
      sessionId,
      cwd: "/repo",
      timestamp: new Date(started).toISOString(),
      type: "user",
      message: { role: "user", content: "Root request" },
    },
    {
      sessionId,
      timestamp: new Date(started + 500).toISOString(),
      type: "assistant",
      message: {
        role: "assistant",
        usage: { input_tokens: 6, output_tokens: 4 },
        content: [{ type: "text", text: "Delegating audit." }],
      },
    },
  ]));
  await writeFile(join(childDir, `agent-${childId}.jsonl`), jsonl([
    {
      sessionId,
      agentId: childId,
      isSidechain: true,
      timestamp: new Date(started + 1_000).toISOString(),
      type: "user",
      message: { role: "user", content: "Audit authentication paths" },
    },
    {
      sessionId,
      agentId: childId,
      isSidechain: true,
      timestamp: new Date(started + 2_000).toISOString(),
      type: "assistant",
      message: {
        role: "assistant",
        usage: { input_tokens: 9, output_tokens: 6 },
        content: [
          { type: "thinking", thinking: "claude private chain" },
          { type: "text", text: "Authentication audit complete." },
          {
            type: "tool_use",
            id: "child-mcp-call",
            name: "mcp__auth__inspect",
            input: { query: "oauth" },
          },
        ],
      },
    },
    {
      sessionId,
      agentId: childId,
      isSidechain: true,
      timestamp: new Date(started + 2_250).toISOString(),
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "child-mcp-call", content: "ok" }],
      },
    },
  ]));
  setEnv(t, "GRANTTAP_CLAUDE_PROJECTS_DIR", root);

  const scan = scanClaude();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId), [sessionId]);
  const parent = scan.sessions[0]!;
  assert.equal(parent.childThreads?.[0]?.threadId, childId);
  assert.equal(parent.childThreads?.[0]?.parentThreadId, sessionId);
  assert.equal(parent.tokensSession, 25);

  const activity = claudeActivity(parent);
  assert.equal(activity.some((entry) => entry.childThreadId === childId), true);
  assert.doesNotMatch(JSON.stringify(activity), /claude private chain/);
  const usage = claudeCapabilityUsage(parent);
  const childMcp = usage.find((item) => item.sourceId === `${childId}:child-mcp-call`);
  assert.equal(childMcp?.sessionId, sessionId);
});
test("Codex rollout subagents fold transitively into the root session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-agentic-codex-"));
  const day = join(root, "2026", "08", "09");
  await mkdir(day, { recursive: true });
  const rootId = "codex-root";
  const childId = "codex-child";
  const grandchildId = "codex-grandchild";
  const started = Date.now() - 8_000;
  await writeFile(join(day, "rollout-root.jsonl"), jsonl([
    {
      timestamp: new Date(started).toISOString(),
      type: "session_meta",
      payload: { id: rootId, cwd: "/repo" },
    },
    {
      timestamp: new Date(started + 100).toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: "Root Codex request" },
    },
    {
      timestamp: new Date(started + 200).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 100 },
          last_token_usage: { total_tokens: 10 },
        },
      },
    },
  ]));
  await writeFile(join(day, "rollout-child.jsonl"), jsonl([
    {
      timestamp: new Date(started + 1_000).toISOString(),
      type: "session_meta",
      payload: {
        id: childId,
        cwd: "/repo",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: rootId,
              depth: 1,
              agent_path: "/root/auth_audit",
              agent_nickname: "Turing",
            },
          },
        },
      },
    },
    {
      timestamp: new Date(started + 1_100).toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: "Inspect auth" },
    },
    {
      timestamp: new Date(started + 1_200).toISOString(),
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "codex private chain" },
    },
    {
      timestamp: new Date(started + 1_300).toISOString(),
      type: "event_msg",
      payload: { type: "agent_message", message: "Child auth result" },
    },
    {
      timestamp: new Date(started + 1_400).toISOString(),
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "codex-child-mcp",
        name: "mcp__auth__inspect",
        arguments: JSON.stringify({ query: "oauth" }),
      },
    },
    {
      timestamp: new Date(started + 1_500).toISOString(),
      type: "response_item",
      payload: { type: "function_call_output", call_id: "codex-child-mcp", output: "ok" },
    },
    {
      timestamp: new Date(started + 1_600).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 30 },
          last_token_usage: { total_tokens: 8 },
        },
      },
    },
  ]));
  await writeFile(join(day, "rollout-grandchild.jsonl"), jsonl([
    {
      timestamp: new Date(started + 2_000).toISOString(),
      type: "session_meta",
      payload: {
        id: grandchildId,
        cwd: "/repo",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: childId,
              depth: 2,
              agent_path: "/root/auth_audit/token_audit",
              agent_nickname: "Noether",
            },
          },
        },
      },
    },
    {
      timestamp: new Date(started + 2_100).toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: "Inspect tokens" },
    },
    {
      timestamp: new Date(started + 2_200).toISOString(),
      type: "event_msg",
      payload: { type: "agent_message", message: "Nested token result" },
    },
    {
      timestamp: new Date(started + 2_300).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 20 },
          last_token_usage: { total_tokens: 5 },
        },
      },
    },
  ]));
  setEnv(t, "GRANTTAP_CODEX_SESSIONS_DIR", root);

  const scan = scanCodex();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId), [rootId]);
  const parent = scan.sessions[0]!;
  assert.equal(parent.tokensSession, 150);
  assert.deepEqual(
    parent.childThreads?.map((child) => [child.threadId, child.parentThreadId, child.depth]),
    [[childId, rootId, 1], [grandchildId, childId, 2]],
  );
  const activity = codexActivity(parent);
  assert.equal(activity.some((entry) => entry.childThreadId === childId), true);
  assert.equal(activity.some((entry) => entry.childThreadId === grandchildId), true);
  assert.doesNotMatch(JSON.stringify(activity), /codex private chain/);
  const mcp = codexCapabilityUsage(parent).find(
    (item) => item.sourceId === `${childId}:codex-child-mcp`,
  );
  assert.equal(mcp?.sessionId, rootId);
});
