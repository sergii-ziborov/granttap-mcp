import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copilotCapabilityUsage,
  scanCopilot,
} from "../apps/bridge/src/sessions/copilot";
import {
  cursorCapabilityUsage,
  scanCursor,
} from "../apps/bridge/src/sessions/cursor";
import { scanCapabilityUsage } from "../apps/bridge/src/sessions";
import {
  MAX_CAPABILITY_USAGE_EVENTS,
  MAX_CAPABILITY_USAGE_PAYLOAD_BYTES,
} from "../apps/bridge/src/sessions/telemetry";

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

test("Cursor indexes root and child MCP/skill/CLI usage without a second walk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-usage-"));
  const sessionId = "cursor-usage-root";
  const childId = "cursor-usage-child";
  const sessionDir = join(
    root,
    "workspace",
    "agent-transcripts",
    sessionId,
  );
  await mkdir(join(sessionDir, "subagents"), { recursive: true });
  const started = Date.now() - 10_000;
  const secret = "sk-proj-cursorsecret123456789";
  await writeFile(join(sessionDir, `${sessionId}.jsonl`), jsonl([
    {
      timestamp: started,
      role: "user",
      message: { content: [{ type: "text", text: "Inspect Cursor telemetry" }] },
    },
    {
      timestamp: started + 1_000,
      role: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "cursor-mcp",
            name: "CallMcpTool",
            input: { server: "user-auth", toolName: "inspect", arguments: { query: "oauth" } },
          },
          {
            type: "tool_use",
            id: "cursor-skill",
            name: "Skill",
            input: { skill: "release-check", args: "fast" },
          },
          {
            type: "tool_use",
            id: "cursor-cli",
            name: "Shell",
            input: {
              command: `OPENAI_API_KEY=${secret} curl --token cursor-token https://u:p@example.test/run?token=query-secret`,
            },
          },
        ],
      },
    },
    {
      timestamp: started + 1_500,
      role: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "cursor-mcp", content: "public result body" },
        ],
      },
    },
  ]));
  await writeFile(join(sessionDir, "subagents", `${childId}.jsonl`), jsonl([
    {
      timestamp: started + 2_000,
      role: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "cursor-child-mcp",
            name: "mcp__repo__search",
            input: { query: "tokens" },
          },
          { type: "thinking", thinking: "CURSOR_PRIVATE_REASONING" },
        ],
      },
    },
  ]));
  setEnv(t, "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", root);
  setEnv(t, "GRANTTAP_CURSOR_STATE_DB", join(root, "missing-state.vscdb"));

  const scan = scanCursor();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId), [sessionId]);
  assert.equal(cursorCapabilityUsage(scan.sessions[0]!).length, 4);

  // If usage attempted another filesystem walk, moving the configured root
  // would clear the provider index and lose all observations.
  await rename(root, `${root}-offline`);
  const status = scanCapabilityUsage(scan.sessions);
  assert.equal(status.events.length, 4);
  assert.equal(status.events.every((event) => event.sessionId === sessionId), true);

  const mcp = status.events.find((event) => event.sourceId.endsWith(":cursor-mcp"));
  assert.equal(mcp?.kind, "mcp");
  assert.equal(mcp?.name, "auth");
  assert.equal(mcp?.toolName, "mcp__auth__inspect");
  assert.equal(mcp?.durationMs, 500);
  assert.ok((mcp?.estimatedContextTokens ?? 0) > 0);

  const child = status.events.find((event) => event.sourceId.startsWith(`${childId}:`));
  assert.equal(child?.sessionId, sessionId);
  assert.equal(child?.name, "repo");
  assert.equal(child?.durationMs, undefined, "unmatched Cursor calls stay input-only");

  const skill = status.events.find((event) => event.kind === "skill");
  assert.equal(skill?.name, "release-check");
  assert.equal(skill?.durationMs, undefined);

  const cli = status.events.find((event) => event.kind === "cli");
  assert.match(cli?.commandPreview ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(
    JSON.stringify(status),
    /cursorsecret|cursor-token|query-secret|CURSOR_PRIVATE_REASONING/,
  );
});

test("Copilot pairs results, deduplicates request/start, and normalizes child usage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-copilot-usage-"));
  const sessionId = "copilot-usage-root";
  const childId = "copilot-usage-child";
  const sessionDir = join(root, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const started = Date.now() - 12_000;
  const secret = "github_pat_CopilotSecret123456789012345";
  await writeFile(join(sessionDir, "events.jsonl"), jsonl([
    {
      timestamp: new Date(started).toISOString(),
      type: "session.start",
      data: { sessionId, startTime: new Date(started).toISOString(), context: { cwd: "/repo" } },
    },
    {
      timestamp: new Date(started + 100).toISOString(),
      type: "user.message",
      data: { content: "Inspect Copilot telemetry" },
    },
    {
      timestamp: new Date(started + 500).toISOString(),
      type: "assistant.message",
      data: {
        content: "Running tools",
        reasoningText: "COPILOT_PRIVATE_REASONING",
        toolRequests: [
          {
            toolCallId: "copilot-mcp",
            name: "github-mcp-server-get_file_contents",
            arguments: { owner: "acme", repo: "app", path: "README.md" },
          },
          {
            toolCallId: "copilot-cli",
            name: "bash",
            arguments: { command: `GITHUB_TOKEN=${secret} gh api --token plain-secret /repos/acme/app` },
          },
          {
            toolCallId: "copilot-skill",
            name: "Skill",
            arguments: { skill: "security-review" },
          },
        ],
      },
    },
    {
      timestamp: new Date(started + 700).toISOString(),
      type: "tool.execution_start",
      data: {
        toolCallId: "copilot-mcp",
        toolName: "github-mcp-server-get_file_contents",
        arguments: { owner: "acme", repo: "app", path: "README.md" },
      },
    },
    {
      timestamp: new Date(started + 800).toISOString(),
      type: "tool.execution_start",
      data: {
        toolCallId: "copilot-cli",
        toolName: "bash",
        arguments: { command: `GITHUB_TOKEN=${secret} gh api --token plain-secret /repos/acme/app` },
      },
    },
    {
      timestamp: new Date(started + 1_100).toISOString(),
      type: "tool.execution_complete",
      data: { toolCallId: "copilot-mcp", success: true, result: "MCP_RESULT_BODY" },
    },
    {
      timestamp: new Date(started + 1_200).toISOString(),
      type: "tool.execution_complete",
      data: { toolCallId: "copilot-cli", success: true, result: "CLI_RESULT_MUST_NOT_LEAK" },
    },
    {
      timestamp: new Date(started + 1_300).toISOString(),
      type: "subagent.started",
      data: { toolCallId: childId, agentDisplayName: "Telemetry child" },
    },
    {
      timestamp: new Date(started + 1_400).toISOString(),
      type: "assistant.message",
      data: {
        parentToolCallId: childId,
        content: "Child lookup",
        toolRequests: [
          {
            toolCallId: "copilot-child-mcp",
            name: "mcp__docs__search",
            arguments: { query: "auth" },
          },
        ],
      },
    },
  ]));
  setEnv(t, "GRANTTAP_COPILOT_SESSIONS_DIR", root);

  const scan = scanCopilot();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId), [sessionId]);
  assert.equal(copilotCapabilityUsage(scan.sessions[0]!).length, 4);

  await rename(root, `${root}-offline`);
  const status = scanCapabilityUsage(scan.sessions);
  assert.equal(status.events.length, 4, "tool request + execution start must not double count");
  assert.equal(status.events.every((event) => event.sessionId === sessionId), true);

  const mcp = status.events.find((event) => event.sourceId.endsWith(":copilot-mcp"));
  assert.equal(mcp?.kind, "mcp");
  assert.equal(mcp?.name, "github-mcp-server");
  assert.equal(mcp?.durationMs, 400);

  const cli = status.events.find((event) => event.kind === "cli");
  assert.equal(cli?.durationMs, 400);
  assert.match(cli?.commandPreview ?? "", /\[REDACTED\]/);

  const skill = status.events.find((event) => event.kind === "skill");
  assert.equal(skill?.name, "security-review");
  assert.equal(skill?.durationMs, undefined, "no result means input-only accounting");

  const child = status.events.find((event) => event.sourceId.startsWith(`${childId}:`));
  assert.equal(child?.sessionId, sessionId);
  assert.equal(child?.name, "docs");
  assert.doesNotMatch(
    JSON.stringify(status),
    /CopilotSecret|plain-secret|COPILOT_PRIVATE_REASONING|MCP_RESULT_BODY|CLI_RESULT_MUST_NOT_LEAK/,
  );
});
