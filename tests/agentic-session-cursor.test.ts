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
        content: [
          { type: "text", text: "Delegating." },
          { type: "tool_use", name: "Bash", input: { command: "git status" } },
        ],
      },
    },
    { role: "assistant", message: { content: "Plain Cursor answer" } },
    { role: "system", message: { content: "hidden" } },
    { role: "user", message: { content: [{ type: "image" }] } },
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
    name: "<user_query>Cursor parent</user_query>",
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
  assert.equal(parent.title, "Cursor parent");
  assert.doesNotMatch(parent.title ?? "", /user_query/);
  assert.equal(parent.childThreads?.[0]?.threadId, childId);
  assert.equal(parent.childThreads?.[0]?.title, "Cursor auth child");
  assert.ok(parent.tokensSession > 27, "Cursor estimates visible user text when usage is absent");
  assert.ok((parent.childThreads?.[0]?.tokensSession ?? 0) > 11);
  const activity = cursorActivity(parent);
  assert.equal(activity.some((entry) => entry.childThreadId === childId), true);
  assert.equal(activity.some((entry) => entry.text === "Plain Cursor answer"), true);
  assert.equal(activity.some((entry) => entry.kind === "tool"), true);
  assert.doesNotMatch(JSON.stringify(activity), /cursor private chain/);
});

test("Cursor Task-tool clones stay under the person chat, not as Working rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-task-fold-"));
  const db = join(root, "state.vscdb");
  execFileSync("sqlite3", [db, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);"]);
  const now = Date.now();
  const insert = (id: string, value: unknown): void => {
    const serialized = JSON.stringify(value).replace(/'/g, "''");
    execFileSync("sqlite3", [db, `INSERT INTO cursorDiskKV VALUES('composerData:${id}','${serialized}');`]);
  };
  insert("chat-root", {
    composerId: "chat-root",
    name: "GrantTap MCP pairing",
    lastUpdatedAt: now,
    createdAt: now - 60_000,
    status: "aborted",
    unfinishedRunAt: now,
    subagentComposerIds: ["listed-child"],
    workspaceIdentifier: { uri: { fsPath: "/repo/granttap-mcp" } },
  });
  insert("listed-child", {
    composerId: "listed-child",
    name: "Inspect pairing",
    lastUpdatedAt: now - 1_000,
    createdAt: now - 50_000,
    status: "completed",
    subagentInfo: {
      parentComposerId: "chat-root",
      rootParentConversationId: "chat-root",
      subagentTypeName: "explore",
    },
    workspaceIdentifier: { uri: { fsPath: "/repo/granttap-mcp" } },
  });
  insert("task-orphan-clone", {
    composerId: "task-orphan-clone",
    name: "Inspect pairing",
    status: "completed",
    subagentComposerIds: [],
    subagentInfo: {
      parentComposerId: "listed-child",
      rootParentConversationId: "chat-root",
      subagentTypeName: "generalPurpose",
    },
    workspaceIdentifier: { uri: { fsPath: "/repo/granttap-mcp" } },
  });
  insert("task-listed-child", {
    composerId: "task-listed-child",
    name: "Inspect pairing clone",
    lastUpdatedAt: now - 500,
    createdAt: now - 50_000,
    status: "completed",
    workspaceIdentifier: { uri: { fsPath: "/repo/granttap-mcp" } },
  });
  setEnv(t, "GRANTTAP_CURSOR_STATE_DB", db);
  setEnv(t, "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", join(root, "missing-transcripts"));
  setEnv(t, "GRANTTAP_COMPOSER_CACHE_MS", "0");

  const scan = scanCursor();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId), ["chat-root"]);
  assert.equal(scan.sessions[0]?.state, "working");
  const childIds = new Set(scan.sessions[0]?.childThreads?.map((child) => child.threadId));
  assert.equal(childIds.has("listed-child"), true);
  assert.equal(childIds.has("task-orphan-clone"), false);
  assert.equal(childIds.has("task-listed-child"), false);
  assert.equal(cursorRootSessionId("task-orphan-clone", db), "chat-root");
  assert.equal(cursorRootSessionId("listed-child", db), "chat-root");
});
