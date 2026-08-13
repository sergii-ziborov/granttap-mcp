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
