import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../../packages/protocol/schema";
import { Payload as PayloadSchema } from "../../packages/protocol/schema";
import {
  diffPreviewFromInput, diffPreviewFromPatch, editStats, MAX_DIFF_PREVIEW_LINES, patchStatsByToolUse,
  secretFilePath, sensitivePath, statsFromInput, statsFromPatch, statsFromPatchText,
} from "../../apps/bridge/src/sessions/support/edit-stats";
import { claudeActivity, scanClaude } from "../../apps/bridge/src/sessions/scan/claude";
import { MAX_THREAD_ENTRIES, scanThreadActivity } from "../../apps/bridge/src/sessions";
import { publishSessionEvents } from "../../apps/bridge/src/monitor";

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
  assert.deepEqual([...patches.entries()], [["t1", { stats: { linesAdded: 1, linesRemoved: 0 }, preview: "+a" }]]);
});

test("the change itself travels bounded and never from a secret file", () => {
  const long = Array.from({ length: 40 }, (_, index) => `+line ${index}`);
  const preview = diffPreviewFromPatch([{ lines: long }])!;
  const lines = preview.split("\n");
  assert.equal(lines.length, MAX_DIFF_PREVIEW_LINES + 1);
  assert.equal(lines.at(-1), "… 16 more lines");
  assert.equal(diffPreviewFromPatch([{ lines: ["+" + "x".repeat(400)] }])!.length, 160);
  assert.equal(diffPreviewFromPatch([]), undefined);
  assert.equal(diffPreviewFromInput("Write", { file_path: "/a", content: "a\nb\n" }), "+a\n+b");
  assert.equal(diffPreviewFromInput("Edit", { old_string: "a", new_string: "b\nc" }), "-a\n+b\n+c");
  assert.equal(diffPreviewFromInput("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }] }), "-a\n+b");
  assert.equal(diffPreviewFromInput("apply_patch", { input: "*** Update File: a\n@@\n-old\n+new\n context\n--- x" }), "-old\n+new\n context");
  assert.equal(diffPreviewFromInput("apply_patch", { input: 7 }), undefined);
  assert.equal(diffPreviewFromInput("Read", { file_path: "/a" }), undefined);
  assert.equal(diffPreviewFromInput("Write", "x"), undefined);
  assert.equal(diffPreviewFromInput("Write", { content: "TOKEN=abc123secret\n" }, (line) => line.replace(/=.*/, "=[REDACTED]")),
    "+TOKEN=[REDACTED]");
  for (const path of ["/repo/.env", "/repo/.env.local", "/home/me/.ssh/id_rsa", "/etc/server.pem", "/repo/config/credentials.json", "/repo/src/token-store.ts"]) {
    assert.equal(sensitivePath(path), true, path);
  }
  for (const path of ["/repo/src/session-keys.ts", "/repo/README.md", "/repo/apps/ios/Environment.swift"]) {
    assert.equal(sensitivePath(path), false, path);
  }
  assert.equal(sensitivePath(undefined), false);
  const secretPatch = patchStatsByToolUse([
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "s" }] },
      toolUseResult: { filePath: "/repo/.env", structuredPatch: [{ lines: ["+KEY=1"] }] } }),
  ], (line) => JSON.parse(line));
  assert.deepEqual(secretPatch.get("s"), { stats: { linesAdded: 1, linesRemoved: 0 }, preview: undefined });
});

test("edit summaries preserve every supported provider shape and reject non-edits", () => {
  assert.deepEqual(statsFromPatch([null, { lines: "no" }, { lines: [1, " keep", "-a", "+b"] }]),
    { linesAdded: 1, linesRemoved: 1 });
  for (const value of [null, 1, "", "   "]) assert.equal(statsFromPatchText(value), undefined);
  assert.deepEqual(statsFromPatchText("*** header\n--- old\n+++ new\n-a\n+b"),
    { linesAdded: 1, linesRemoved: 1 });
  assert.deepEqual(statsFromInput("provider.write_file", { contents: "a\nb" }),
    { linesAdded: 2, linesRemoved: 0 });
  assert.deepEqual(statsFromInput("create_file", { text: "a" }), { linesAdded: 1, linesRemoved: 0 });
  assert.deepEqual(statsFromInput("edit_file", { old_str: "a\n", new_str: "b\n" }),
    { linesAdded: 1, linesRemoved: 1 });
  assert.deepEqual(statsFromInput("str_replace_editor", { old_string: "a", code_edit: "b\nc" }),
    { linesAdded: 2, linesRemoved: 1 });
  assert.equal(statsFromInput("multiedit", { edits: "no" }), undefined);
  assert.equal(statsFromInput("multiedit", { edits: [null, {}] }), undefined);
  assert.deepEqual(statsFromInput("apply_patch", { diff: "-a\n+b" }),
    { linesAdded: 1, linesRemoved: 1 });
  assert.deepEqual(editStats("read", {}, [{ lines: [] }]),
    { linesAdded: 0, linesRemoved: 0 }, "an observed empty patch reports zero changed lines");
});

test("diff previews bound controls, aliases, redaction, and secret path families", () => {
  assert.equal(diffPreviewFromPatch(null), undefined);
  assert.equal(diffPreviewFromPatch([null, { lines: "no" }, { lines: [1] }]), undefined);
  assert.equal(diffPreviewFromPatch([{ lines: ["+a\u0001b"] }]), "+ab");
  assert.equal(diffPreviewFromPatch([{ lines: ["+one", "+two"] }], (line) => line.toUpperCase()),
    "+ONE\n+TWO");
  const oneLeft = Array.from({ length: MAX_DIFF_PREVIEW_LINES + 1 }, () => "+x");
  assert.match(diffPreviewFromPatch([{ lines: oneLeft }]) ?? "", /… 1 more line$/);
  const charBound = Array.from({ length: MAX_DIFF_PREVIEW_LINES }, () => "+" + "x".repeat(159));
  assert.ok((diffPreviewFromPatch([{ lines: charBound }])?.length ?? 0) <= 2_500);

  assert.equal(diffPreviewFromInput("write_file", { contents: "a\n" }), "+a");
  assert.equal(diffPreviewFromInput("create_file", { text: "a" }), "+a");
  assert.equal(diffPreviewFromInput("edit_file", { old_str: "a\n", new_str: "b\n" }), "-a\n+b");
  assert.equal(diffPreviewFromInput("str_replace_based_edit_tool", { code_edit: "b" }), "+b");
  assert.equal(diffPreviewFromInput("multiedit", { edits: "no" }), undefined);
  assert.equal(diffPreviewFromInput("multiedit", { edits: [null, { old_string: "a" }] }), "-a");
  assert.equal(diffPreviewFromInput("apply_patch", { patch: "header\n context\n+++ a\n--- b\n+x" }),
    " context\n+x");

  for (const path of [
    ".env", "prod.env", "server.key", "id_ed25519.pub", "secrets.yaml",
    "service_account.json", ".npmrc", ".docker/config.json", "state.tfstate.backup",
  ]) assert.equal(secretFilePath(path), true, path);
  for (const path of [undefined, 1, "tokenizer.ts", "credentials-view.swift"]) {
    assert.equal(secretFilePath(path), false, String(path));
  }

  const rows = patchStatsByToolUse([
    "ordinary row",
    "structuredPatch invalid json",
    JSON.stringify({ toolUseResult: { structuredPatch: [{ lines: ["+x"] }] }, message: { content: [] } }),
    JSON.stringify({ toolUseResult: { structuredPatch: [] }, message: { content: [] } }),
    JSON.stringify({ toolUseResult: { structuredPatch: [{ lines: ["+x"] }] }, message: { content: [
      null, { type: "text" }, { type: "tool_result", tool_use_id: 7 },
      { type: "tool_result", tool_use_id: "ok" },
    ] } }),
  ], (line) => { try { return JSON.parse(line); } catch { return null; } });
  assert.deepEqual(rows.get("ok"), { stats: { linesAdded: 1, linesRemoved: 0 }, preview: "+x" });
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
  assert.equal(edit.diffPreview, "-b\n+B\n+C", "the patch's own lines travel with the row");
  assert.equal(write.diffPreview, "+a\n+b\n+c", "a created file is all additions");
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
