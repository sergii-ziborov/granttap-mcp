import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../packages/protocol/schema";
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

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function setEnvironment(t: test.TestContext, key: string, value: string): void {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("Claude parses visible array messages, errors, pending tools, and a disappearing child", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claude-parser-"));
  const project = join(root, "project");
  const sessionId = "claude-parser";
  const childDir = join(project, sessionId, "subagents");
  const childPath = join(childDir, "agent-helper.jsonl");
  await mkdir(childDir, { recursive: true });
  const now = Date.now();
  const parentRows = [
    { sessionId, cwd: "/repo", gitBranch: "main", timestamp: now / 1000,
      type: "user", message: { role: "user", content: [
        { type: "image" }, { type: "text", text: "Check reconnect" },
      ] } },
    { sessionId, timestamp: String(now + 10), type: "assistant",
      message: { role: "assistant", content: "Working on it", usage: {
        input_tokens: 4, output_tokens: 3, cache_creation_input_tokens: 2,
      } } },
    { sessionId, timestamp: now + 20, type: "assistant", message: {
      role: "assistant", content: [
        { type: "text", text: "Running checks" },
        { type: "tool_use", id: "failed", name: "mcp__qa__run", input: { suite: "reconnect" } },
        { type: "tool_use", id: "pending", name: "Bash", input: { command: "git status" } },
        { type: "tool_use", name: "Read", input: { file_path: "README.md" } },
      ], usage: { input_tokens: 2, output_tokens: 1 },
    } },
    { sessionId, timestamp: now + 30, type: "user", message: {
      role: "user", content: [
        { type: "tool_result", tool_use_id: "failed", content: "failed", is_error: true },
        { type: "text", text: "Visible follow up" },
      ],
    } },
  ];
  await writeFile(join(project, `${sessionId}.jsonl`), jsonl(parentRows));
  await writeFile(childPath, jsonl([{ agentId: "helper", timestamp: now + 5, type: "user",
    message: { role: "user", content: [{ type: "text", text: "Child work" }] } }]));
  setEnvironment(t, "GRANTTAP_CLAUDE_PROJECTS_DIR", root);

  const session = scanClaude().sessions[0]!;
  assert.equal(session.title, "Check reconnect");
  const usage = claudeCapabilityUsage(session);
  assert.equal(usage.find((item) => item.mcpServer === "qa")?.outcome, "error");
  assert.equal(usage.some((item) => item.cli && item.outcome === "unknown"), true);
  const activity = claudeActivity(session);
  assert.equal(activity.some((item) => item.text === "Working on it"), true);
  assert.equal(activity.some((item) => item.text === "Visible follow up"), true);
  assert.equal(activity.filter((item) => item.kind === "tool").length >= 3, true);

  await rm(childPath);
  assert.equal(claudeActivity(session).some((item) => item.childThreadId === "helper"), false);
});

test("Codex fallback discovery parses access, bounded usage, tools, and visible messages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-parser-"));
  const day = join(root, "2026", "08", "23");
  await mkdir(day, { recursive: true });
  const now = Date.now();
  const sessionId = "codex-fallback";
  const path = join(day, "rollout-fallback.jsonl");
  const rows = [
    { timestamp: now / 1000, type: "session_meta", payload: {
      id: sessionId, cwd: "/repo", model: "gpt-5", git: { branch: "main" }, title: "Fallback",
    } },
    { timestamp: now + 1, type: "turn_context", payload: {
      model: "gpt-5.6", sandbox_policy: { type: "read-only" },
    } },
    { timestamp: now + 2, type: "turn_context", payload: {
      sandbox_policy: { type: "workspace-write" },
    } },
    { timestamp: now + 3, type: "turn_context", payload: {
      sandbox_policy: { type: "danger-full-access" },
    } },
    { timestamp: now + 4, type: "event_msg", payload: {
      type: "user_message", message: "Event user",
    } },
    { timestamp: now + 5, type: "event_msg", payload: {
      type: "agent_message", message: "Event assistant",
    } },
    { timestamp: now + 6, type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "text", text: "Block user" }],
    } },
    { timestamp: now + 7, type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "text", text: "Block assistant" }],
    } },
    { timestamp: now + 8, type: "response_item", payload: {
      type: "local_shell_call", call_id: "shell", action: "git status",
    } },
    { timestamp: now + 9, type: "response_item", payload: {
      type: "function_call", call_id: "ok", name: "mcp__qa__run", arguments: { suite: "all" },
    } },
    { timestamp: now + 10, type: "response_item", payload: {
      type: "function_call_output", call_id: "ok", output: "ok",
    } },
    { timestamp: now + 11, type: "response_item", payload: {
      type: "custom_tool_call", call_id: "pending", name: "exec_command",
      input: "tools.mcp__docs__read() and tools.mcp__github__get_issue()",
    } },
    { timestamp: now + 12, type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { total_tokens: Number.POSITIVE_INFINITY },
      last_token_usage: { total_tokens: 40, cached_input_tokens: 5, input_tokens: 25 },
      model_context_window: 200_000,
    } } },
  ];
  await writeFile(path, jsonl(rows));
  setEnvironment(t, "GRANTTAP_CODEX_SESSIONS_DIR", root);

  const scan = scanCodex();
  const session = scan.sessions[0]!;
  assert.equal(session.accessLevel, "full");
  assert.equal(session.tokensLastTurn, 35);
  assert.equal(codexCapabilityUsage(session).some((item) => item.mcpServer === "qa"), true);
  const activity = codexActivity(session);
  assert.equal(activity.some((item) => item.text === "Event user"), true);
  assert.equal(activity.some((item) => item.text === "Block assistant"), true);

  const unknown: SessionInfo = { ...session, sessionId: "not-indexed" };
  assert.deepEqual(codexCapabilityUsage(unknown), []);
  assert.deepEqual(codexActivity(unknown), []);
  await rm(path);
  assert.deepEqual(codexActivity(session), []);
});

test("Codex capability results ignore unmatched outputs and bound nested duration", () => {
  const session: SessionInfo = {
    sessionId: "direct", agent: "codex", cwd: "/repo", state: "idle",
    startedAt: 1, lastActivityAt: 5_000, tokensSession: 0, tokensLastTurn: 0,
  };
  const lines = [
    JSON.stringify({ timestamp: 5_000, type: "response_item", payload: {
      type: "function_call_output", call_id: "missing", output: "ignored",
    } }),
    JSON.stringify({ timestamp: 5_000, type: "response_item", payload: {
      type: "function_call", call_id: "nested", name: "exec_command",
      arguments: "tools.mcp__one__a() tools.mcp__two__b()",
    } }),
    JSON.stringify({ timestamp: 4_000, type: "response_item", payload: {
      type: "function_call_output", call_id: "nested", output: { error: "bad" },
    } }),
  ];
  const usage = codexCapabilityUsage(session, lines);
  assert.equal(usage.filter((item) => item.mcpServer).length, 2);
  assert.equal(usage.every((item) => item.outcome === "error"), true);
  assert.equal(usage.every((item) => item.durationMs == null), true);
});
