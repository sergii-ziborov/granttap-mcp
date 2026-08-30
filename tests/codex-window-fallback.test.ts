import assert from "node:assert/strict";
import { chmodSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../packages/protocol/schema";
import { codexActivity, scanCodex } from "../apps/bridge/src/sessions/codex";

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function sessionsRoot(t: any): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-window-"));
  await mkdir(join(root, "2026", "08", "23"), { recursive: true });
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = root;
  t.after(() => { delete process.env.GRANTTAP_CODEX_SESSIONS_DIR; });
  return join(root, "2026", "08", "23");
}

test("Codex keeps oversized rollouts bounded and skips unreadable files", async (t) => {
  const day = await sessionsRoot(t);
  const now = Date.now();
  const filler = "x".repeat(900 * 1024);
  await writeFile(join(day, "rollout-large.jsonl"), jsonl([
    { timestamp: new Date(now - 9_000).toISOString(), type: "session_meta", payload: {
      id: "large-session", cwd: "/repo", model: "gpt-5", git: { branch: "main" },
    } },
    { timestamp: new Date(now - 8_000).toISOString(), type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: "<app-context>internal</app-context>" }],
    } },
    { timestamp: new Date(now - 7_000).toISOString(), type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: "Audit the release" }],
    } },
    { timestamp: new Date(now - 6_000).toISOString(), type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: filler }],
    } },
    { timestamp: new Date(now - 1_000).toISOString(), type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: "Release audit finished." }],
    } },
    { timestamp: new Date(now - 900).toISOString(), type: "event_msg", payload: {
      type: "token_count", info: { total_token_usage: { total_tokens: 400, cached_input_tokens: 100 } },
    } },
  ]));

  const unreadable = join(day, "rollout-unreadable.jsonl");
  await writeFile(unreadable, jsonl([
    { timestamp: new Date(now - 5_000).toISOString(), type: "session_meta", payload: { id: "unreadable-session" } },
  ]));
  chmodSync(unreadable, 0o000);
  t.after(() => { try { chmodSync(unreadable, 0o600); } catch { /* already restored */ } });

  const scan = scanCodex();
  const large = scan.sessions.find((session) => session.sessionId === "large-session");
  assert.ok(large, "the oversized rollout must still produce a session");
  assert.equal(large?.cwd, "/repo");
  assert.equal(large?.model, "gpt-5");
  assert.notEqual(large?.title, "<app-context>internal</app-context>");
  assert.equal(scan.sessions.some((session) => session.sessionId === "unreadable-session"), false);

  const entries = codexActivity(large as SessionInfo);
  assert.equal(entries.some((entry) => entry.text?.includes("Release audit finished.")), true);
  assert.equal(entries.some((entry) => entry.text === filler), false);
});

test("Codex retains the first request when its row contains an attached image", async (t) => {
  const day = await sessionsRoot(t);
  const now = Date.now();
  const image = "a".repeat(360 * 1024);
  const later = "x".repeat(900 * 1024);
  await writeFile(join(day, "rollout-attached.jsonl"), jsonl([
    { timestamp: new Date(now - 4_000).toISOString(), type: "session_meta", payload: {
      id: "attached-session", cwd: "/repo", model: "gpt-5",
    } },
    { timestamp: new Date(now - 3_000).toISOString(), type: "response_item", payload: {
      type: "message", role: "user", content: [
        { type: "input_text", text: "Inspect the attached screen" },
        { type: "input_image", image_url: `data:image/jpeg;base64,${image}` },
      ],
    } },
    { timestamp: new Date(now - 2_000).toISOString(), type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: later }],
    } },
    { timestamp: new Date(now - 1_000).toISOString(), type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }],
    } },
  ]));

  const session = scanCodex().sessions.find((item) => item.sessionId === "attached-session");
  assert.equal(session?.title, "Inspect the attached screen");
  const entries = codexActivity(session as SessionInfo);
  assert.equal(entries.some((entry) => entry.text === "Inspect the attached screen"), true);
  assert.equal(entries.some((entry) => entry.text === later), false);
});

test("Codex names an orphan parent row and reloads activity without a warm path", async (t) => {
  const day = await sessionsRoot(t);
  const now = Date.now();
  const child = (id: string, offset: number, title?: string) => jsonl([
    { timestamp: new Date(now - offset).toISOString(), type: "session_meta", payload: {
      id, cwd: "/repo", model: "gpt-5", source: { subagent: { thread_spawn: {
        parent_thread_id: "orphan-root", depth: 1,
        agent_path: "/agents/release_reviewer", agent_nickname: "Ada",
      } } },
    } },
    ...(title
      ? [{ timestamp: new Date(now - offset + 100).toISOString(), type: "response_item", payload: {
          type: "message", role: "user", content: [{ type: "input_text", text: title }],
        } }]
      : []),
    { timestamp: new Date(now - offset + 200).toISOString(), type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: `Done ${id}` }],
    } },
  ]);
  await writeFile(join(day, "rollout-child-a.jsonl"), child("child-a", 4_000));
  await writeFile(join(day, "rollout-child-b.jsonl"), child("child-b", 2_000, "Verify signing"));

  const scan = scanCodex();
  const root = scan.sessions.find((session) => session.sessionId === "orphan-root");
  assert.ok(root, "an orphan parent thread must stay reachable as one root row");
  assert.equal(root?.title, "Verify signing");
  assert.deepEqual(
    root?.childThreads?.map((thread) => thread.threadId).sort(),
    ["child-a", "child-b"],
  );
  assert.equal(scan.sessions.some((session) => session.sessionId === "child-a"), false);

  const rootEntries = codexActivity(root as SessionInfo);
  assert.equal(rootEntries.some((entry) => entry.text?.includes("Done child-b")), true);

  unlinkSync(join(day, "rollout-child-b.jsonl"));
  const afterDelete = codexActivity(root as SessionInfo);
  assert.equal(afterDelete.some((entry) => entry.text?.includes("Done child-a")), true);
});

test("Codex activity falls back to a file scan for an unindexed session", async (t) => {
  const day = await sessionsRoot(t);
  const now = Date.now();
  await writeFile(join(day, "rollout-unindexed.jsonl"), jsonl([
    { timestamp: new Date(now - 3_000).toISOString(), type: "session_meta", payload: {
      id: "unindexed-session", cwd: "/repo", model: "gpt-5",
    } },
    { timestamp: new Date(now - 2_000).toISOString(), type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered from disk." }],
    } },
  ]));

  const session = {
    sessionId: "unindexed-session", agent: "codex", state: "idle",
    startedAt: now - 3_000, lastActivityAt: now - 2_000,
    tokensSession: 0, tokensLastTurn: 0,
  } as unknown as SessionInfo;
  const entries = codexActivity(session);
  assert.equal(entries.some((entry) => entry.text?.includes("Recovered from disk.")), true);

  const missing = { ...session, sessionId: "never-written-session" } as SessionInfo;
  assert.deepEqual(codexActivity(missing), []);
});
