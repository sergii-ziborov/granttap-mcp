import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import {
  scanSessionActivity,
  scanSessionHistory,
  scanSessionHistoryForPaging,
  scanSessions,
  scanSessionsCooperatively,
  scanThreadActivity,
} from "../../sessions";
import { scanClaude } from "../../sessions/scan/claude";
import { attachHelperRuns } from "../attach";
import { rememberHelperRunLinks } from "../links";

const TEMP = "/private/var/folders/ab/c0ffee123/T";
const PARENT = "parent-chat-0001";

function roots(t: TestContext): { claude: string; grok: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "granttap-helper-catalog-"));
  const names = ["GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_CONFIG_DIR"] as const;
  const previous = names.map((name) => process.env[name]);
  const paths = { claude: join(root, "claude"), grok: join(root, "grok"), config: join(root, "config") };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = paths.claude;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = paths.grok;
  process.env.GRANTTAP_CONFIG_DIR = paths.config;
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    });
    rmSync(root, { recursive: true, force: true });
  });
  return paths;
}

function claudeChat(root: string, id: string, at: number): void {
  writeFileSync(join(root, `${id}.jsonl`), [
    { type: "user", sessionId: id, timestamp: new Date(at).toISOString(), message: { role: "user", content: "Synthetic request for a picture" } },
    { type: "assistant", sessionId: id, timestamp: new Date(at + 1_000).toISOString(),
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Synthetic answer" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function grokSession(root: string, input: { id: string; cwd: string; at: number; kind?: string; title?: string;
  /** How many requests the session was given; one unless said. */
  requests?: number; checkoutRoot?: string; pictures?: boolean }): void {
  const directory = join(root, encodeURIComponent(input.cwd), input.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "summary.json"), JSON.stringify({
    info: { id: input.id, cwd: input.cwd }, generated_title: input.title ?? `Title of ${input.id}`,
    created_at: new Date(input.at).toISOString(), updated_at: new Date(input.at + 30_000).toISOString(),
    current_model_id: "grok-synthetic", ...(input.kind ? { session_kind: input.kind } : {}),
    ...(input.checkoutRoot ? { git_root_dir: input.checkoutRoot } : {}),
  }));
  writeFileSync(join(directory, "chat_history.jsonl"), Array.from({ length: input.requests ?? 1 }, (_, index) => [
    { type: "user", prompt_index: index, content: [{ type: "text", text: `Synthetic prompt${index ? ` ${index + 1}` : ""} of ${input.id}` }] },
    { type: "assistant", content: [{ type: "text", text: `Synthetic result${index ? ` ${index + 1}` : ""} of ${input.id}` }] },
  ]).flat().map((row) => JSON.stringify(row)).join("\n"));
  if (input.pictures) {
    mkdirSync(join(directory, "images"));
    writeFileSync(join(directory, "images", "1.jpg"), "synthetic");
  }
  writeFileSync(join(directory, "events.jsonl"),
    JSON.stringify({ type: "turn_ended", ts: new Date(input.at + 30_000).toISOString() }) + "\n");
}

function fixture(t: TestContext) {
  const paths = roots(t);
  const now = Date.now() - 10 * 60_000;
  claudeChat(paths.claude, PARENT, now);
  const linked = `${TEMP}/hw-image-linked01`;
  grokSession(paths.grok, { id: "helper-linked-0001", cwd: linked, at: now + 2_000, kind: "headless", title: "A lighthouse at dusk" });
  grokSession(paths.grok, { id: "helper-orphan-0001", cwd: `${TEMP}/hw-image-orphan01`, at: now + 3_000, kind: "headless" });
  grokSession(paths.grok, { id: "helper-lost-parent", cwd: `${TEMP}/hw-image-lostpar1`, at: now + 4_000, kind: "headless" });
  grokSession(paths.grok, { id: "ordinary-temp-0001", cwd: `${TEMP}/granttap-scratch-1`, at: now + 5_000, kind: "headless", requests: 2 });
  grokSession(paths.grok, { id: "typed-in-such-a-folder", cwd: `${TEMP}/hw-image-typed001`, at: now + 6_000 });
  grokSession(paths.grok, { id: "ordinary-project-chat", cwd: "/Users/someone/dev/app", at: now + 7_000, kind: "headless" });
  rememberHelperRunLinks([
    { folder: linked, kind: "image-generation", parentAgent: "claude", parentSessionId: PARENT, capturedAt: now + 2_500 },
    { folder: `${TEMP}/hw-image-lostpar1`, kind: "image-generation", parentAgent: "claude",
      parentSessionId: "a-chat-no-longer-on-this-computer", capturedAt: now + 4_500 },
  ]);
  return { paths, now, linked };
}

test("an image generation run is not a chat of its own: it is a conversation of the chat that started it", async (t) => {
  fixture(t);
  const lists = [
    scanSessions().sessions, (await scanSessionsCooperatively()).sessions,
    scanSessionHistory(), scanSessionHistoryForPaging().sessions,
  ];
  for (const sessions of lists) {
    assert.deepEqual(sessions.map((session) => session.sessionId).sort(),
      ["ordinary-project-chat", "ordinary-temp-0001", PARENT, "typed-in-such-a-folder"].sort());
    const parent = sessions.find((session) => session.sessionId === PARENT)!;
    assert.equal(parent.childThreads?.length, 1);
    const child = parent.childThreads![0]!;
    assert.deepEqual(
      { threadId: child.threadId, parentThreadId: child.parentThreadId, kind: child.kind, agentName: child.agentName,
        title: child.title, depth: child.depth, state: child.state },
      { threadId: "helper-linked-0001", parentThreadId: PARENT, kind: "image-generation", agentName: "Image generation",
        title: "A lighthouse at dusk", depth: 1, state: "idle" });
    assert.ok(child.lastActivityAt > child.startedAt);
    for (const other of sessions.filter((session) => session.sessionId !== PARENT)) {
      assert.equal(other.childThreads, undefined, other.sessionId);
    }
  }
});

test("a headless run in a folder made for it is not a chat either, whatever the folder was called", (t) => {
  const paths = roots(t);
  const now = Date.now() - 10 * 60_000;
  claudeChat(paths.claude, PARENT, now);
  // A checkout whose script made one folder per picture under its build folder and removed each afterwards.
  const checkout = join(paths.config, "..", "app");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  const job = (name: string) => join(checkout, "build", "imagegen", name);
  const worktree = join(checkout, "worktrees", "removed-one");
  grokSession(paths.grok, { id: "job-linked-0001", cwd: job("job.linked"), at: now + 2_000, kind: "headless",
    checkoutRoot: `${checkout}/`, pictures: true, title: "Dots under a curve" });
  grokSession(paths.grok, { id: "job-orphan-0001", cwd: job("job.orphan"), at: now + 3_000, kind: "headless", checkoutRoot: `${checkout}/` });
  grokSession(paths.grok, { id: "job-continued-01", cwd: job("job.talked"), at: now + 4_000, kind: "headless", requests: 2 });
  grokSession(paths.grok, { id: "job-typed-000001", cwd: job("job.typed"), at: now + 5_000 });
  grokSession(paths.grok, { id: "removed-worktree", cwd: worktree, at: now + 6_000, kind: "headless", checkoutRoot: worktree });
  grokSession(paths.grok, { id: "later-in-that-folder", cwd: job("job.linked"), at: now + 5 * 60_000, kind: "headless", requests: 2 });
  rememberHelperRunLinks([{ folder: job("job.linked"), kind: "helper-run", parentAgent: "claude",
    parentSessionId: PARENT, capturedAt: now + 2_500 }]);

  const sessions = scanSessions().sessions;
  assert.deepEqual(sessions.map((session) => session.sessionId).sort(),
    ["job-continued-01", "job-typed-000001", "later-in-that-folder", PARENT, "removed-worktree"].sort(),
    "a run given a second request, one a person typed in, and a chat in a checkout of its own stay chats");
  const child = sessions.find((session) => session.sessionId === PARENT)!.childThreads!;
  assert.deepEqual(child.map((thread) => [thread.threadId, thread.kind, thread.agentName, thread.title]),
    [["job-linked-0001", "image-generation", "Image generation", "Dots under a curve"]],
    "the linked run is the chat's conversation, called by what it made; the one nobody was named for is published nowhere");
});

test("the chat's own state, clock and spend are its own after a helper run is attached", (t) => {
  fixture(t);
  const own = (session: SessionInfo) => ({ ...session, childThreads: undefined, transfer: undefined });
  const alone = scanClaude().sessions.find((session) => session.sessionId === PARENT)!;
  const attached = scanSessions().sessions.find((session) => session.sessionId === PARENT)!;
  assert.equal(alone.childThreads, undefined);
  assert.equal(attached.childThreads?.length, 1);
  assert.deepEqual(own(attached), own(alone));
});

test("the run's conversation is read from the run and shown under the chat", (t) => {
  fixture(t);
  const parent = scanSessions().sessions.find((session) => session.sessionId === PARENT)!;
  const thread = scanThreadActivity(parent, "helper-linked-0001");
  assert.deepEqual({ sessionId: thread.sessionId, agent: thread.agent, threadId: thread.threadId },
    { sessionId: PARENT, agent: "claude", threadId: "helper-linked-0001" });
  assert.deepEqual(thread.entries.map((entry) => [entry.text, entry.childThreadId, entry.childThreadDepth]), [
    ["Synthetic prompt of helper-linked-0001", "helper-linked-0001", 1],
    ["Synthetic result of helper-linked-0001", "helper-linked-0001", 1],
  ]);
  assert.equal(thread.entries[0]?.kind, "user");
  assert.equal(thread.entries[0]?.childThreadTitle, "A lighthouse at dusk");
  assert.deepEqual(scanThreadActivity(parent, "helper-orphan-0001").entries, [],
    "a run that is not this chat's cannot be read through it");
  // A monitor that has just started serves the catalog it saved before it has scanned again.
  attachHelperRuns([], []);
  assert.deepEqual(scanThreadActivity(parent, "helper-linked-0001").entries.map((entry) => entry.text),
    thread.entries.map((entry) => entry.text));
  const own = scanSessionActivity(parent);
  assert.ok(own.entries.length > 0);
  assert.ok(own.entries.every((entry) => !entry.childThreadId), "the chat's own window is its own messages");
});

test("a chat keeps its newest helper runs within the bound a phone accepts", (t) => {
  const { paths, now } = fixture(t);
  const links = Array.from({ length: 40 }, (_item, index) => {
    const cwd = `${TEMP}/hw-image-many${String(index).padStart(4, "0")}`;
    grokSession(paths.grok, { id: `helper-many-${String(index).padStart(4, "0")}`, cwd, at: now + 60_000 + index * 1_000, kind: "headless" });
    return { folder: cwd, kind: "image-generation", parentAgent: "claude" as const, parentSessionId: PARENT, capturedAt: now };
  });
  rememberHelperRunLinks(links);
  const children = scanSessions().sessions.find((session) => session.sessionId === PARENT)!.childThreads!;
  assert.equal(children.length, 32);
  assert.equal(children.at(-1)?.threadId, "helper-many-0039");
  assert.ok(!children.some((child) => child.threadId === "helper-linked-0001"), "the oldest runs make room");
});
