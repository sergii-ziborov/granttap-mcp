import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../packages/protocol/schema";
import { Payload as PayloadSchema } from "../packages/protocol/schema";
import {
  editStats, patchStatsByToolUse, statsFromInput, statsFromPatch, statsFromPatchText,
} from "../apps/bridge/src/sessions/edit-stats";
import { claudeActivity, scanClaude } from "../apps/bridge/src/sessions/claude";
import { MAX_THREAD_ENTRIES, scanThreadActivity } from "../apps/bridge/src/sessions";
import { publishSessionEvents } from "../apps/bridge/src/monitor";

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

class FakeRelayClient {
  readonly room = "thread-events-room";
  isConnected = true;
  sent: Payload[] = [];
  sessionSent: Array<{ payload: Payload; sessionId: string }> = [];
  onMessage(): () => void { return () => {}; }
  setSessionKey(): void {}
  async send(payload: Payload): Promise<void> { this.sent.push(payload); }
  async sendSession(payload: Payload, sessionId: string): Promise<void> {
    this.sessionSent.push({ payload, sessionId });
  }
}

test("edit statistics read like git: the patch when there is one, the call otherwise", () => {
  assert.deepEqual(statsFromPatch([{ lines: ["-b", "+B", "+C", " keep"] }]), { linesAdded: 2, linesRemoved: 1 });
  assert.equal(statsFromPatch([]), undefined, "an empty patch says nothing; the call does");
  assert.equal(statsFromPatch("nope"), undefined);
  assert.deepEqual(statsFromInput("Write", { file_path: "/a", content: "a\nb\nc\n" }), { linesAdded: 3, linesRemoved: 0 });
  assert.equal(statsFromInput("Write", { file_path: "/a", content: "" }), undefined);
  assert.deepEqual(statsFromInput("Edit", { old_string: "a\nb", new_string: "a\nB\nC" }), { linesAdded: 3, linesRemoved: 2 });
  assert.deepEqual(statsFromInput("MultiEdit", { edits: [{ old_string: "a", new_string: "b\nc" }, { old_string: "", new_string: "d" }] }),
    { linesAdded: 3, linesRemoved: 1 });
  assert.equal(statsFromInput("MultiEdit", { edits: [] }), undefined);
  assert.deepEqual(statsFromInput("apply_patch", { input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n+more\n*** End Patch" }),
    { linesAdded: 2, linesRemoved: 1 });
  assert.equal(statsFromPatchText("--- a\n+++ b\n"), undefined);
  assert.equal(statsFromInput("Read", { file_path: "/a" }), undefined);
  assert.equal(statsFromInput("Write", "not an object"), undefined);
  assert.deepEqual(editStats("Write", { content: "x" }, [{ lines: ["+1", "+2"] }]), { linesAdded: 2, linesRemoved: 0 });
  assert.deepEqual(editStats("Write", { content: "x" }), { linesAdded: 1, linesRemoved: 0 });
  const patches = patchStatsByToolUse([
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t1" }] }, toolUseResult: { structuredPatch: [{ lines: ["+a"] }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t2" }] }, toolUseResult: { structuredPatch: [] } }),
    "not json at all structuredPatch",
    JSON.stringify({ message: { content: "text" }, toolUseResult: { structuredPatch: [{ lines: ["+b"] }] } }),
  ], (line) => { try { return JSON.parse(line); } catch { return null; } });
  assert.deepEqual([...patches.entries()], [["t1", { linesAdded: 1, linesRemoved: 0 }]]);
});

test("a Write reads +3 and an Edit +2 −1, and one agent conversation is fetched whole", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-thread-events-"));
  const project = join(root, "project");
  const sessionId = "claude-root";
  const childId = "claude-child";
  const childDir = join(project, sessionId, "subagents");
  await mkdir(childDir, { recursive: true });
  const started = Date.now() - 5_000;
  const at = (offset: number) => new Date(started + offset).toISOString();
  await writeFile(join(project, `${sessionId}.jsonl`), jsonl([
    { sessionId, cwd: "/repo", timestamp: at(0), type: "user", message: { role: "user", content: "Root request" } },
    { sessionId, timestamp: at(100), type: "assistant", message: { role: "assistant", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/repo/a.swift", content: "a\nb\nc\n" } }] } },
    { sessionId, timestamp: at(200), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "write-1", content: "ok" }] },
      toolUseResult: { type: "create", filePath: "/repo/a.swift", content: "a\nb\nc\n", structuredPatch: [] } },
    { sessionId, timestamp: at(300), type: "assistant", message: { role: "assistant", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/repo/a.swift", old_string: "b", new_string: "B\nC" } }] } },
    { sessionId, timestamp: at(400), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "edit-1", content: "ok" }] },
      toolUseResult: { filePath: "/repo/a.swift", oldString: "b", newString: "B\nC",
        structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, lines: ["-b", "+B", "+C"] }] } },
    { sessionId, timestamp: at(500), type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
  ]));
  await writeFile(join(childDir, `agent-${childId}.jsonl`), jsonl([
    { sessionId, agentId: childId, isSidechain: true, timestamp: at(1_000), type: "user", message: { role: "user", content: "Audit the tests" } },
    { sessionId, agentId: childId, isSidechain: true, timestamp: at(1_100), type: "assistant", message: { role: "assistant",
      usage: { input_tokens: 2, output_tokens: 2 }, content: [{ type: "text", text: "Audit complete." },
        { type: "tool_use", id: "child-write", name: "Write", input: { file_path: "/repo/notes.md", content: "x\ny" } }] } },
  ]));
  setEnv(t, "GRANTTAP_CLAUDE_PROJECTS_DIR", root);

  const parent = scanClaude().sessions.find((session) => session.sessionId === sessionId)!;
  const activity = claudeActivity(parent);
  const write = activity.find((entry) => entry.toolName === "Write" && !entry.childThreadId)!;
  assert.deepEqual([write.linesAdded, write.linesRemoved], [3, 0], "a created file is all additions");
  const edit = activity.find((entry) => entry.toolName === "Edit")!;
  assert.deepEqual([edit.linesAdded, edit.linesRemoved], [2, 1], "from the patch the host wrote");
  const childWrite = activity.find((entry) => entry.toolName === "Write" && entry.childThreadId === childId)!;
  assert.deepEqual([childWrite.linesAdded, childWrite.linesRemoved], [2, 0], "estimated from the call when no patch exists");
  assert.equal(activity.find((entry) => entry.kind === "user" && !entry.childThreadId)?.linesAdded, undefined);

  const thread = scanThreadActivity(parent, childId);
  assert.equal(thread.threadId, childId);
  assert.equal(thread.entries.length, 3);
  assert.ok(thread.entries.every((entry) => entry.childThreadId === childId));
  assert.ok(MAX_THREAD_ENTRIES >= 24);
  assert.equal(scanThreadActivity(parent, "nobody").entries.length, 0);

  const fake = new FakeRelayClient();
  assert.equal(await publishSessionEvents(fake as never, sessionId, undefined, childId), true);
  const published = fake.sessionSent.at(-1)!.payload as Extract<Payload, { type: "session.activity" }>;
  assert.equal(published.type, "session.activity");
  assert.equal(published.threadId, childId);
  assert.equal(published.entries.length, 3);
  assert.equal(await publishSessionEvents(fake as never, "missing", undefined, childId), false);
  assert.equal(await publishSessionEvents(fake as never, sessionId), true);
  assert.equal((fake.sessionSent.at(-1)!.payload as { threadId?: string }).threadId, undefined);

  const request = PayloadSchema.parse({ type: "session.events", sessionId, threadId: childId, createdAt: 1 });
  assert.equal(request.type, "session.events");
  assert.equal(PayloadSchema.parse(published).type, "session.activity");
});
