import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanClaude } from "../../../apps/bridge/src/sessions/scan/claude";

test("Claude ignores malformed usage counters without replacing valid totals or context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claude-usage-"));
  const project = join(root, "project");
  await mkdir(project);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const previous = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = previous;
  });

  const now = Date.now();
  const sessionId = "claude-invalid-usage";
  const rows = [
    { sessionId, timestamp: now, type: "user", message: { role: "user", content: "Inspect" } },
    { sessionId, timestamp: now + 1, type: "assistant", message: {
      role: "assistant", model: "claude-sonnet", content: "Valid",
      usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 3 },
    } },
    { sessionId, timestamp: now + 2, type: "assistant", message: {
      role: "assistant", model: "claude-sonnet", content: "Malformed",
      usage: { input_tokens: "100", output_tokens: 200, cache_read_input_tokens: "1" },
    } },
  ];
  await writeFile(join(project, `${sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = scanClaude().sessions.find((item) => item.sessionId === sessionId);
  assert.ok(session);
  assert.equal(session.tokensSession, 7);
  assert.equal(session.tokensLastTurn, 7);
  assert.equal(session.contextTokensUsed, 8);
});
