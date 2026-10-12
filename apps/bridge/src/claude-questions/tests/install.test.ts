import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installClaudeHook, hookCommand } from "../../install";

test("repair registers native Claude questions without replacing another integration's hooks", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-question-hook-"));
  const old = process.env.GRANTTAP_CLAUDE_DIR;
  process.env.GRANTTAP_CLAUDE_DIR = root;
  t.after(() => { if (old == null) delete process.env.GRANTTAP_CLAUDE_DIR;
    else process.env.GRANTTAP_CLAUDE_DIR = old; rmSync(root, { recursive: true }); });
  const unrelated = { matcher: "Read", hooks: [{ type: "command", command: "echo independent" }] };
  const settings = { hooks: { PreToolUse: [unrelated, { matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*|Skill|skill__.*",
    hooks: [{ type: "command", command: hookCommand("claude"), timeout: 120 }] }] } };
  writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  installClaudeHook();
  const saved = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
  assert.deepEqual(saved.hooks.PreToolUse[0], unrelated);
  const owned = saved.hooks.PreToolUse[1];
  assert.ok(new RegExp(`^(${owned.matcher})$`).test("AskUserQuestion"));
  assert.equal(owned.hooks.length, 1);
});
