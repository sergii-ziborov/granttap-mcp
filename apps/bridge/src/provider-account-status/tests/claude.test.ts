import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClaudeUsageStatusLine, projectClaudeUsage, readClaudeUsage, runClaudeStatusLine } from "../claude-statusline";

test("Claude reports only independently present native subscription windows", () => {
  const report = projectClaudeUsage({ prompt: "private", model: { id: "private" }, rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 500 }, seven_day: null,
  } }, 100);
  assert.deepEqual(report, { provider: "claude", limitId: "claude", observedAt: 100,
    windows: [{ id: "primary", usedPercent: 23.5, windowMinutes: 300, resetsAt: 500_000 }] });
  assert.equal(projectClaudeUsage({ rate_limits: { five_hour: { used_percentage: 100, resets_at: 1 } } }, 5_000), undefined);
  assert.equal(projectClaudeUsage({}), undefined);
});

test("status renderer keeps prior settings and stores no transcript or account identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-statusline-"));
  const old = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  try {
    const settings = { statusLine: { type: "command", command: "true", padding: 3 } };
    assert.equal(ensureClaudeUsageStatusLine(settings, "node granttap internal hook claude-statusline"), true);
    assert.equal(settings.statusLine.padding, 3);
    assert.equal(ensureClaudeUsageStatusLine(settings, settings.statusLine.command), false);
    assert.equal(JSON.parse(readFileSync(join(root, "claude-statusline-previous.json"), "utf8")).command, "true");
    await runClaudeStatusLine(JSON.stringify({ cwd: "private", rate_limits: {
      seven_day: { used_percentage: 40, resets_at: Date.now() / 1_000 + 1_000 },
    } }));
    assert.equal(readClaudeUsage()[0]?.windows[0]?.usedPercent, 40);
    assert.equal(readClaudeUsage(Date.now() + 400_000).length, 0);
    assert.equal(readFileSync(join(root, "claude-account-usage.json"), "utf8").includes("private"), false);
  } finally {
    if (old === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
