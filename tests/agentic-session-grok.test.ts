import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  grokActivity,
  grokCapabilityUsage,
  scanGrok,
} from "../apps/bridge/src/sessions/grok";

test("Grok Build sessions expose visible activity without hidden reasoning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-session-"));
  const session = join(root, "repo", "grok-session");
  await mkdir(session, { recursive: true });
  const now = Date.now();
  await writeFile(join(session, "summary.json"), JSON.stringify({
    info: { id: "grok-session", cwd: "/repo" }, generated_title: "Grok verification",
    created_at: now - 2_000, updated_at: now, current_model_id: "grok-build",
  }));
  await writeFile(join(session, "chat_history.jsonl"), [
    JSON.stringify({ role: "user", timestamp: now - 2_000, content: "Verify reconnect" }),
    JSON.stringify({ role: "reasoning", content: "private grok chain" }),
    JSON.stringify({ role: "assistant", timestamp: now - 1_000, content: [
      { type: "text", text: "Running external verification." },
      { type: "tool_use", id: "call-1", name: "mcp__github__get_issue", input: { issue: 3 } },
    ] }),
  ].join("\n") + "\n");
  const previous = process.env.GRANTTAP_GROK_SESSIONS_DIR;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  t.after(() => previous == null
    ? delete process.env.GRANTTAP_GROK_SESSIONS_DIR
    : process.env.GRANTTAP_GROK_SESSIONS_DIR = previous);

  const scan = scanGrok();
  assert.equal(scan.sessions.length, 1);
  const value = scan.sessions[0]!;
  assert.equal(value.agent, "grok");
  assert.equal(value.title, "Grok verification");
  assert.equal(value.model, "grok-build");
  assert.ok(value.tokensSession > 0);
  const activity = grokActivity(value);
  assert.match(JSON.stringify(activity), /external verification/);
  assert.doesNotMatch(JSON.stringify(activity), /private grok chain/);
  const usage = grokCapabilityUsage(value);
  assert.equal(usage[0]?.mcpServer, "github");
  assert.equal(usage[0]?.outcome, "unknown");
});
