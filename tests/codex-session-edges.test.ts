import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../packages/protocol/schema";
import {
  codexActivity, codexCapabilityUsage, scanCodex,
} from "../apps/bridge/src/sessions/codex";

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test("Codex fallback roots retain structured activity and nested capability outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-edges-"));
  const day = join(root, "2026", "08", "23");
  await mkdir(day, { recursive: true });
  const path = join(day, "rollout-child-only.jsonl");
  const now = Date.now();
  const rows = [
    { timestamp: new Date(now - 2_000).toISOString(), type: "session_meta", payload: {
      id: "child-only", cwd: "/repo", model: "gpt-5", source: { subagent: { thread_spawn: {
        parent_thread_id: "missing-root", depth: 1, agent_path: "/root/docs_agent", agent_nickname: "Ada",
      } } },
    } },
    { timestamp: new Date(now - 1_900).toISOString(), type: "response_item", payload: {
      type: "message", role: "user", content: [
        { type: "input_text", text: "Review docs" }, { type: "image", url: "ignored" },
      ],
    } },
    { timestamp: new Date(now - 1_800).toISOString(), type: "response_item", payload: {
      type: "message", role: "assistant", content: [
        { type: "output_text", text: "Checking documentation." }, { type: "text", text: "Still working." },
      ],
    } },
    { timestamp: new Date(now - 1_700).toISOString(), type: "response_item", payload: {
      type: "local_shell_call", id: "shell", action: { command: "git status" },
    } },
    { timestamp: new Date(now - 1_600).toISOString(), type: "response_item", payload: {
      type: "function_call", call_id: "nested", name: "exec_command",
      arguments: "Run tools.mcp__github__get_issue({issue: 3}) and tools.mcp__linear__get_issue({id: 1})",
    } },
    { timestamp: new Date(now - 1_500).toISOString(), type: "response_item", payload: {
      type: "function_call_output", call_id: "nested", output: { error: "not found" },
    } },
    { timestamp: new Date(now - 1_400).toISOString(), type: "response_item", payload: {
      type: "custom_tool_call", call_id: "pending", name: "mcp__github__list", input: { owner: "openai" },
    } },
    { timestamp: new Date(now - 1_300).toISOString(), type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: "unknown", content: "ignored",
    } },
    { timestamp: new Date(now - 1_200).toISOString(), type: "event_msg", payload: {
      type: "token_count", info: {
        total_token_usage: { total_tokens: 50, cached_input_tokens: 20 },
        last_token_usage: { total_tokens: 10, cached_input_tokens: 2 },
        model_context_window: 128_000,
      },
    } },
  ];
  await writeFile(path, jsonl(rows));
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = root;
  t.after(() => delete process.env.GRANTTAP_CODEX_SESSIONS_DIR);

  const first = scanCodex();
  assert.deepEqual(first.sessions.map((session) => session.sessionId), ["missing-root"]);
  const parent = first.sessions[0]!;
  assert.equal(parent.title, "Review docs");
  assert.equal(parent.childThreads?.[0]?.agentName, "Ada");
  assert.equal(parent.tokensSession, 30);
  assert.equal(parent.contextWindow, 128_000);
  const second = scanCodex();
  assert.equal(second.sessions[0]?.sessionId, "missing-root");
  const usage = codexCapabilityUsage(parent);
  assert.equal(usage.some((item) => item.cli), true);
  assert.equal(usage.filter((item) => item.mcpServer === "github").length >= 2, true);
  assert.equal(usage.some((item) => item.mcpServer === "linear" && item.outcome === "error"), true);
  const activity = codexActivity(parent);
  assert.equal(activity.some((item) => item.kind === "user" && /Review docs/.test(item.text)), true);
  assert.equal(activity.some((item) => item.kind === "message" && /Checking/.test(item.text)), true);
  assert.equal(activity.some((item) => item.kind === "tool"), true);

  await rm(path);
  assert.deepEqual(codexActivity(parent), []);
});

test("Codex capability parser rejects unrelated rows and preserves pending observations", () => {
  const session: SessionInfo = {
    sessionId: "manual", agent: "codex", cwd: "/repo", state: "idle",
    startedAt: 1, lastActivityAt: 10, tokensSession: 0, tokensLastTurn: 0,
  };
  const lines = [
    "not-json",
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message" } }),
    JSON.stringify({ timestamp: "invalid", type: "response_item", payload: {
      type: "function_call", id: "raw", name: "mcp__docs__lookup", arguments: "{bad json",
    } }),
    JSON.stringify({ type: "response_item", payload: {
      type: "custom_tool_call", call_id: "circular", name: "exec_command", input: "tools.mcp__docs__read()",
    } }),
  ];
  const usage = codexCapabilityUsage(session, lines);
  assert.equal(usage.some((item) => item.mcpServer === "docs"), true);
  assert.equal(usage.every((item) => item.outcome === "unknown"), true);
});
