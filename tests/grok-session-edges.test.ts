import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { grokActivity, grokCapabilityUsage, scanGrok } from "../apps/bridge/src/sessions/grok";

test("Grok discovery bounds malformed sessions and accepts visible string/block content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-edges-"));
  const valid = join(root, "valid");
  const fallback = join(root, "fallback");
  const invalid = join(root, "invalid");
  await Promise.all([valid, fallback, invalid].map((path) => mkdir(path, { recursive: true })));
  const now = Date.now();
  await writeFile(join(valid, "summary.json"), JSON.stringify({
    info: { id: "grok-edge", cwd: "/repo" }, session_summary: "Edge verification",
    created_at: "invalid", updated_at: new Date(now).toISOString(), current_model_id: 123,
  }));
  await writeFile(join(valid, "chat_history.jsonl"), [
    "not-json",
    JSON.stringify({ role: "system", content: "hidden" }),
    JSON.stringify({ role: "user", timestamp: now - 10, message: { role: "user", content: "String prompt" } }),
    JSON.stringify({ role: "assistant", timestamp: now, message: { role: "assistant", content: [
      null, { type: "thinking", thinking: "hidden" }, { type: "text", text: "Visible result" },
      { type: "tool_use", name: "Skill", input: { skill: "review" } },
      { type: "tool_use", id: "shell", name: "Shell", input: { command: "git status" } },
    ] } }),
    JSON.stringify({ role: "other", content: "ignored" }),
  ].join("\n"));
  await writeFile(join(fallback, "summary.json"), JSON.stringify({
    info: {}, generated_title: "Fallback session", updated_at: now - 1_000,
  }));
  await writeFile(join(invalid, "summary.json"), "not-json");
  const oversized = join(root, "oversized");
  await mkdir(oversized);
  await writeFile(join(oversized, "summary.json"), JSON.stringify({
    info: { id: "x".repeat(300) }, updated_at: now,
  }));
  process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  t.after(() => delete process.env.GRANTTAP_GROK_SESSIONS_DIR);

  const scan = scanGrok();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId).sort(), ["fallback", "grok-edge"]);
  const session = scan.sessions.find((item) => item.sessionId === "grok-edge")!;
  assert.equal(session.title, "Edge verification");
  assert.equal(session.model, undefined);
  assert.match(JSON.stringify(grokActivity(session)), /String prompt|Visible result/);
  assert.doesNotMatch(JSON.stringify(grokActivity(session)), /hidden/);
  const usage = grokCapabilityUsage(session);
  assert.equal(usage.some((item) => item.skill === "review"), true);
  assert.equal(usage.some((item) => item.cli), true);
  assert.deepEqual(grokActivity({ ...session, sessionId: "missing" }), []);
  assert.deepEqual(grokCapabilityUsage({ ...session, sessionId: "missing" }), []);
});
