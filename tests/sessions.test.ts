import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  scanCapabilityUsage,
  scanSessionActivity,
  scanSessionHistory,
  scanSessions,
  TOKEN_WINDOW_HOURS,
} from "../apps/bridge/src/sessions";

test("session activity exposes visible text/tools but never thinking blocks", async (t) => {
  const claudeRoot = await mkdtemp(join(tmpdir(), "granttap-claude-"));
  const codexRoot = await mkdtemp(join(tmpdir(), "granttap-codex-"));
  const project = join(claudeRoot, "project");
  await mkdir(project);
  const sessionId = "session-visible";
  const timestamp = new Date().toISOString();
  const rows = [
    { sessionId, cwd: "/repo", timestamp, type: "user", message: { role: "user", content: "work" } },
    {
      sessionId,
      cwd: "/repo",
      timestamp,
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-test",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 40 },
        content: [
          { type: "thinking", thinking: "hidden chain of thought" },
          { type: "text", text: "Checking the working tree." },
          { type: "tool_use", id: "tool-github", name: "mcp__github__status",
            input: { command: "git status --short" } },
          { type: "text", text: "Done. There are no changes." },
        ],
      },
    },
    { sessionId, cwd: "/repo", timestamp, type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-github", content: "clean working tree" },
    ] } },
  ];
  await writeFile(join(project, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n"));

  const previousClaude = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  const previousCodex = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = claudeRoot;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = codexRoot;
  t.after(() => {
    if (previousClaude == null) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = previousClaude;
    if (previousCodex == null) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previousCodex;
  });

  const scan = scanSessions();
  assert.equal(TOKEN_WINDOW_HOURS, 12);
  assert.equal(scan.tokensRecent, 17);
  assert.equal(scan.sessions.length, 1);
  assert.equal(scan.sessions[0]?.summary, "Done. There are no changes.");
  assert.equal(scan.sessions[0]?.contextTokensUsed, 52);
  assert.equal(scan.sessions[0]?.contextWindow, undefined);
  const activity = scanSessionActivity(scan.sessions[0]!);
  assert.equal(activity.entries.length, 4);
  assert.equal(activity.entries.some((entry) => entry.kind === "user" && entry.text === "work"), true);
  assert.equal(activity.entries.some((entry) => entry.kind === "tool" && /git status/.test(entry.text)), true);
  assert.equal(activity.entries.find((entry) => entry.kind === "tool")?.mcpServer, "github");
  assert.equal(activity.entries.find((entry) => entry.kind === "tool")?.toolName, "mcp__github__status");
  const capabilityUsage = scanCapabilityUsage(scan.sessions);
  assert.equal(capabilityUsage.events.length, 1);
  assert.equal(capabilityUsage.events[0]?.name, "github");
  assert.equal((capabilityUsage.events[0]?.estimatedContextTokens ?? 0) > 0, true);
  assert.doesNotMatch(JSON.stringify(activity), /hidden chain of thought/);

  const completed = scanSessionActivity({ ...scan.sessions[0]!, state: "idle" });
  assert.deepEqual(completed.entries.map((entry) => entry.kind), ["user", "message", "tool", "final"]);
  assert.match(completed.entries.at(-1)?.text ?? "", /Done/);
});

test("session detail is bounded to 24 entries and 700 characters per entry", async (t) => {
  const claudeRoot = await mkdtemp(join(tmpdir(), "granttap-claude-bounded-"));
  const codexRoot = await mkdtemp(join(tmpdir(), "granttap-codex-bounded-"));
  const project = join(claudeRoot, "project");
  await mkdir(project);
  const sessionId = "session-bounded";
  const timestamp = new Date().toISOString();
  const rows = Array.from({ length: 40 }, (_, index) => ({
    sessionId,
    cwd: "/repo",
    timestamp,
    type: "assistant",
    message: {
      role: "assistant",
      content: `${index}: ${"x".repeat(1_200)}`,
    },
  }));
  await writeFile(join(project, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n"));

  const previousClaude = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  const previousCodex = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = claudeRoot;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = codexRoot;
  t.after(() => {
    if (previousClaude == null) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = previousClaude;
    if (previousCodex == null) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previousCodex;
  });

  const session = scanSessions().sessions[0];
  assert.ok(session);
  const activity = scanSessionActivity(session);
  assert.equal(activity.entries.length, 24);
  assert.equal(activity.entries.every((entry) => entry.text.length <= 700), true);
});

test("older local chats are excluded from live usage but included in bounded history", async (t) => {
  const claudeRoot = await mkdtemp(join(tmpdir(), "granttap-claude-history-"));
  const codexRoot = await mkdtemp(join(tmpdir(), "granttap-codex-history-"));
  const project = join(claudeRoot, "project");
  await mkdir(project);
  const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  const sessionId = "older-chat";
  const file = join(project, `${sessionId}.jsonl`);
  await writeFile(file, [
    { sessionId, cwd: "/repo", timestamp: oldDate.toISOString(), type: "user",
      message: { role: "user", content: "Old task" } },
    { sessionId, cwd: "/repo", timestamp: oldDate.toISOString(), type: "assistant",
      message: { role: "assistant", usage: { input_tokens: 4, output_tokens: 2 }, content: "Finished." } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  await utimes(file, oldDate, oldDate);

  const previousClaude = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  const previousCodex = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = claudeRoot;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = codexRoot;
  t.after(() => {
    if (previousClaude == null) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = previousClaude;
    if (previousCodex == null) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previousCodex;
  });

  assert.equal(scanSessions().sessions.length, 0);
  const history = scanSessionHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0]?.sessionId, sessionId);
  assert.equal(history[0]?.tokensSession, 6);
});

test("Codex tasks and visible activity are discovered from local rollouts", async (t) => {
  const claudeRoot = await mkdtemp(join(tmpdir(), "granttap-claude-empty-"));
  const codexRoot = await mkdtemp(join(tmpdir(), "granttap-codex-session-"));
  const day = join(codexRoot, "2026", "07", "22");
  await mkdir(day, { recursive: true });
  const sessionId = "codex-visible";
  const timestamp = new Date().toISOString();
  const rows = [
    { timestamp, type: "session_meta", payload: { id: sessionId, cwd: "/repo", git: { branch: "main" } } },
    { timestamp, type: "turn_context", payload: { model: "gpt-test", sandbox_policy: { type: "workspace-write" } } },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nInternal bootstrap\n</INSTRUCTIONS>",
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "# Files mentioned by the user:\n\n## Photo 1.jpg: /tmp/example.jpg\n\n## My request for Codex:\n\nBuild the feature",
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<recommended_plugins>internal list</recommended_plugins>" },
          { type: "input_text", text: "<environment_context><cwd>/secret</cwd></environment_context>" },
        ],
      },
    },
    { timestamp, type: "event_msg", payload: { type: "agent_reasoning", text: "private reasoning" } },
    { timestamp, type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Checking files." } },
    { timestamp, type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "**Plan**\n\n- First\n- Second" } },
    {
      timestamp,
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "custom_tool_call", call_id: "call-node-repl", name: "exec",
        input: "const result = await tools.mcp__node_repl__js({ code: '1 + 1' }); text(result);",
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call-node-repl", output: "2" },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "custom_tool_call", call_id: "call-exec-wrapper", name: "exec",
        input: "const result = await tools.exec_command({ cmd: 'pwd' }); text(result.output);",
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call-exec-wrapper", output: "/repo" },
    },
    { timestamp, type: "event_msg", payload: { type: "agent_message", phase: "final", message: "Done." } },
    {
      timestamp,
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "echo cleanup" }) },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 30_000_000, cached_input_tokens: 29_999_970 },
          last_token_usage: { total_tokens: 180_008, input_tokens: 180_004, cached_input_tokens: 180_000 },
          model_context_window: 258_400,
        },
      },
    },
  ];
  await writeFile(join(day, "rollout-test.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));

  const previousClaude = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  const previousCodex = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = claudeRoot;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = codexRoot;
  t.after(() => {
    if (previousClaude == null) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = previousClaude;
    if (previousCodex == null) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previousCodex;
  });

  const scan = scanSessions();
  assert.equal(scan.sessions[0]?.title, "Build the feature");
  assert.equal(scan.sessions[0]?.model, "gpt-test");
  assert.equal(scan.sessions[0]?.branch, "main");
  assert.equal(scan.sessions[0]?.summary, "Done.");
  assert.equal(scan.sessions[0]?.accessLevel, "workspace");
  assert.equal(scan.tokensRecent, 30);
  assert.equal(scan.sessions[0]?.tokensSession, 30);
  assert.equal(scan.sessions[0]?.tokensLastTurn, 8);
  assert.equal(scan.sessions[0]?.contextTokensUsed, 180_004);
  assert.equal(scan.sessions[0]?.contextWindow, 258_400);
  const activity = scanSessionActivity(scan.sessions[0]!);
  assert.equal(activity.entries.find((entry) => entry.kind === "user")?.text, "Build the feature");
  assert.equal(activity.entries.some((entry) => entry.kind === "user" && /Build the feature/.test(entry.text)), true);
  assert.equal(activity.entries.some((entry) => entry.kind === "tool" && /git status/.test(entry.text)), true);
  assert.equal(activity.entries.some((entry) => entry.text.includes("**Plan**\n\n- First")), true);
  assert.doesNotMatch(JSON.stringify(activity), /private reasoning/);
  assert.doesNotMatch(JSON.stringify(activity), /recommended_plugins|environment_context|\/secret/);
  const capabilityUsage = scanCapabilityUsage(scan.sessions);
  const nestedMcp = capabilityUsage.events.find((event) => event.kind === "mcp");
  const cli = capabilityUsage.events.filter((event) => event.kind === "cli");
  assert.equal(nestedMcp?.name, "node_repl");
  assert.equal(nestedMcp?.toolName, "mcp__node_repl__js");
  assert.equal((nestedMcp?.estimatedContextTokens ?? 0) > 0, true);
  assert.deepEqual(cli.map((event) => event.commandPreview).sort(), [
    "const result = await tools.exec_command({ cmd: 'pwd' }); text(result.output);",
    "echo cleanup",
    "git status --short",
  ]);
});
