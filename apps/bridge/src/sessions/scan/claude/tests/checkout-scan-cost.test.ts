import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanClaude, scanClaudeCooperatively } from "..";

test("Claude shares checkout verification across files and asynchronous scan steps", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-claude-checkout-"));
  const original = join(root, "original"), observed = join(root, "observed");
  const logs = join(root, "logs"), bin = join(root, "bin"), calls = join(root, "calls");
  for (const path of [original, observed, logs, bin]) mkdirSync(path);
  for (const path of [original, observed]) execFileSync("/usr/bin/git", ["init", "-q", path]);
  const prior = { path: process.env.PATH, logs: process.env.GRANTTAP_CLAUDE_PROJECTS_DIR };
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf x >> '${calls}'\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${prior.path}`;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = logs;
  t.after(() => {
    process.env.PATH = prior.path;
    if (prior.logs === undefined) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = prior.logs;
    rmSync(root, { recursive: true, force: true });
  });
  const writeLogs = (revision: number) => {
    for (let index = 0; index < 3; index++) {
      const row = { type: "assistant", sessionId: `fixture-${index}`, cwd: original,
        timestamp: new Date().toISOString(), revision,
        message: { role: "assistant", content: Array.from({ length: 3 }, (_, j) => ({
          type: "tool_use", id: `tool-${j}`, name: "Bash", input: { command: "pwd", cwd: observed },
        })) } };
      writeFileSync(join(logs, `fixture-${index}.jsonl`), JSON.stringify(row) + "\n");
    }
  };
  for (const [index, read] of [scanClaude, scanClaudeCooperatively].entries()) {
    writeLogs(index);
    const scanned = await read(3);
    assert.equal(scanned.sessions.length, 3);
    assert.ok(scanned.sessions.every(session => session.worktree === realpathSync(observed)));
    assert.equal(readFileSync(calls, "utf8").length, (index + 1) * 2,
      "Each scan verifies repeated roots once, including across event-loop yields.");
  }
});
