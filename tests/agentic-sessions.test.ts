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

test("child metadata is bounded while parent token accounting includes every child", () => {
  const now = Date.now();
  const parent = SessionInfo.parse({
    sessionId: "root",
    agent: "codex",
    state: "idle",
    startedAt: now,
    lastActivityAt: now,
    tokensSession: 5,
    tokensLastTurn: 5,
  });
  const aggregated = aggregateChildThreads(
    parent,
    Array.from({ length: 40 }, (_, index) => ({
      threadId: `child-${index}`,
      parentThreadId: "root",
      title: `Child ${index}`,
      depth: 1,
      state: "idle" as const,
      startedAt: now + index,
      lastActivityAt: now + index,
      tokensSession: 10,
      tokensLastTurn: 2,
    })),
  );
  assert.equal(aggregated.childThreads?.length, 32);
  assert.equal(aggregated.tokensSession, 405, "bounded navigation must not truncate spend");
  assert.doesNotThrow(() => SessionInfo.parse(aggregated));
});

test("Cursor policy scope resolves nested parents and fails closed on ambiguity or cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-policy-scope-"));
  const db = join(root, "state.vscdb");
  execFileSync("sqlite3", [db, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);"]);
  const insert = (id: string, children: string[]): void => {
    const payload = JSON.stringify({ composerId: id, subagentComposerIds: children })
      .replace(/'/g, "''");
    execFileSync("sqlite3", [db,
      `INSERT INTO cursorDiskKV(key,value) VALUES('composerData:${id}', '${payload}');`,
    ]);
  };
  insert("root", ["child", "ambiguous"]);
  insert("child", ["grandchild"]);
  insert("other-root", ["ambiguous"]);
  insert("cycle-a", ["cycle-b"]);
  insert("cycle-b", ["cycle-a"]);

  assert.equal(cursorRootSessionId("grandchild", db), "root");
  assert.equal(cursorRootSessionId("ambiguous", db), "ambiguous");
  assert.equal(cursorRootSessionId("cycle-a", db), "cycle-a");
  assert.equal(cursorRootSessionId("unknown", db), "unknown");
  assert.equal(cursorRootSessionId(" ", db), null);
});

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

test("Cursor subagent transcript is grouped under its composer parent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-agentic-cursor-"));
  const db = join(root, "state.vscdb");
  const transcripts = join(root, "projects");
  const project = join(transcripts, "Users-test-repo", "agent-transcripts");
  const parentId = "cursor-root";
  const childId = "cursor-child";
  const parentDir = join(project, parentId);
  await mkdir(join(parentDir, "subagents"), { recursive: true });
  await writeFile(join(parentDir, `${parentId}.jsonl`), jsonl([
    { role: "user", message: { content: [{ type: "text", text: "Root cursor request" }] } },
    {
      role: "assistant",
      message: {
        usage: { input_tokens: 12, output_tokens: 4 },
        content: [{ type: "text", text: "Delegating." }],
      },
    },
  ]));
  await writeFile(join(parentDir, "subagents", `${childId}.jsonl`), jsonl([
    {
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>Inspect Cursor auth</user_query>" }] },
    },
    {
      role: "assistant",
      message: {
        usage: { input_tokens: 8, output_tokens: 3 },
        content: [
          { type: "thinking", thinking: "cursor private chain" },
          { type: "text", text: "Cursor child result" },
        ],
      },
    },
  ]));
  execFileSync("sqlite3", [db, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);"]);
  const now = Date.now();
  const insert = (id: string, value: unknown): void => {
    const serialized = JSON.stringify(value).replace(/'/g, "''");
    execFileSync("sqlite3", [db, `INSERT INTO cursorDiskKV VALUES('composerData:${id}','${serialized}');`]);
  };
  insert(parentId, {
    composerId: parentId,
    name: "Cursor parent",
    lastUpdatedAt: now,
    createdAt: now - 1_000,
    status: "completed",
    subagentComposerIds: [childId],
    workspaceIdentifier: { uri: { fsPath: "/test/repo" } },
  });
  insert(childId, {
    composerId: childId,
    name: "Cursor auth child",
    lastUpdatedAt: now,
    createdAt: now,
    status: "completed",
    subagentComposerIds: [],
    workspaceIdentifier: { uri: { fsPath: "/test/repo" } },
  });
  setEnv(t, "GRANTTAP_CURSOR_STATE_DB", db);
  setEnv(t, "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", transcripts);

  const scan = scanCursor();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId), [parentId]);
  const parent = scan.sessions[0]!;
  assert.equal(parent.childThreads?.[0]?.threadId, childId);
  assert.equal(parent.childThreads?.[0]?.title, "Cursor auth child");
  assert.ok(parent.tokensSession > 27, "Cursor estimates visible user text when usage is absent");
  assert.ok((parent.childThreads?.[0]?.tokensSession ?? 0) > 11);
  const activity = cursorActivity(parent);
  assert.equal(activity.some((entry) => entry.childThreadId === childId), true);
  assert.doesNotMatch(JSON.stringify(activity), /cursor private chain/);
});

test("Copilot parentToolCallId groups nested output without exposing reasoningText", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-agentic-copilot-"));
  const sessionId = "copilot-root";
  const sessionDir = join(root, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const childId = "copilot-child-call";
  const started = Date.now() - 4_000;
  await writeFile(join(sessionDir, "events.jsonl"), jsonl([
    {
      timestamp: new Date(started).toISOString(),
      type: "session.start",
      data: { sessionId, startTime: new Date(started).toISOString(), context: { cwd: "/repo" } },
    },
    {
      timestamp: new Date(started + 100).toISOString(),
      type: "user.message",
      data: { content: "Root Copilot request" },
    },
    {
      timestamp: new Date(started + 500).toISOString(),
      type: "subagent.started",
      data: {
        toolCallId: childId,
        agentName: "explore",
        agentDisplayName: "Auth explorer",
        agentDescription: "Inspect Copilot auth",
      },
    },
    {
      timestamp: new Date(started + 1_000).toISOString(),
      type: "assistant.message",
      data: {
        parentToolCallId: childId,
        content: "Copilot child result",
        outputTokens: 7,
        reasoningText: "copilot private chain",
        reasoningOpaque: "opaque-private",
        toolRequests: [],
      },
    },
    {
      timestamp: new Date(started + 1_100).toISOString(),
      type: "subagent.completed",
      data: { toolCallId: childId, agentName: "explore", agentDisplayName: "Auth explorer" },
    },
    {
      timestamp: new Date(started + 1_500).toISOString(),
      type: "assistant.message",
      data: { content: "Root complete", outputTokens: 3, toolRequests: [] },
    },
  ]));
  setEnv(t, "GRANTTAP_COPILOT_SESSIONS_DIR", root);

  const scan = scanCopilot();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId), [sessionId]);
  const parent = scan.sessions[0]!;
  assert.equal(parent.tokensSession, 10);
  assert.equal(parent.childThreads?.[0]?.threadId, childId);
  assert.equal(parent.childThreads?.[0]?.tokensSession, 7);
  const activity = copilotActivity(parent);
  assert.equal(
    activity.find((entry) => entry.text === "Copilot child result")?.childThreadId,
    childId,
  );
  assert.doesNotMatch(JSON.stringify(activity), /copilot private chain|opaque-private/);
});
