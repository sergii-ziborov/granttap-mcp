import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { grokActivity, scanGrok } from "../grok";

test("Grok typed history exposes real turns without environment, reminders, or reasoning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-typed-"));
  const directory = join(root, "project", "typed-session");
  await mkdir(directory, { recursive: true });
  const previous = process.env.GRANTTAP_GROK_SESSIONS_DIR;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    else process.env.GRANTTAP_GROK_SESSIONS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(directory, "summary.json"), JSON.stringify({
    info: { id: "typed-session", cwd: "/project" },
    updated_at: new Date().toISOString(), current_model_id: "grok-build",
  }));
  const rows = [
    { type: "system", content: "private system" },
    { type: "user", content: [{ type: "text", text: "private environment" }] },
    { type: "user", synthetic_reason: "system_reminder", prompt_index: 0, content: "private reminder" },
    { type: "user", prompt_index: -1, content: "private invalid index" },
    { type: "user", prompt_index: 0.5, content: "private fractional index" },
    { type: "user", prompt_index: 0, content: [{ type: "text", text: "First request" }] },
    { type: "reasoning", summary: "private reasoning", encrypted_content: "private encrypted data" },
    { type: "assistant", content: "First answer", model_id: "grok-build" },
    { type: "user", prompt_index: 1, content: [{ type: "text", text: "Continue this task" }] },
    { type: "assistant", content: [{ type: "text", text: "Second answer" }] },
  ];
  await writeFile(join(directory, "chat_history.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
  const session = scanGrok().sessions[0]!;
  assert.equal(session.title, "First request");
  const activity = grokActivity(session, true);
  assert.deepEqual(activity.map((entry) => [entry.kind, entry.text]), [
    ["user", "First request"], ["message", "First answer"],
    ["user", "Continue this task"], ["message", "Second answer"],
  ]);
  assert.doesNotMatch(JSON.stringify(activity), /private/);
  assert.equal(new Set(activity.map((entry) => entry.id)).size, 4);
  assert.deepEqual(grokActivity(session).map((entry) => entry.id), activity.map((entry) => entry.id),
    "Catalog and full transcript must identify the same messages");
  const history = join(directory, "chat_history.jsonl");
  await appendFile(history, "\n" + JSON.stringify({ type: "user", prompt_index: 2, content: "One more request" }));
  const later = new Date(Date.now() + 60_000);
  await utimes(history, later, later);
  const refreshed = scanGrok().sessions[0]!;
  const updated = grokActivity(refreshed);
  assert.deepEqual(updated.slice(0, 4).map((entry) => [entry.id, entry.createdAt]),
    activity.map((entry) => [entry.id, entry.createdAt]), "Appending a turn must not move earlier messages");
  assert.equal(updated.length, 5);
});
