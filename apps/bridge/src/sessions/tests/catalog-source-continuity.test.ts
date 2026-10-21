import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { scanClaude, scanClaudeCooperatively } from "../scan/claude";
import { scanCodex, scanCodexCooperatively } from "../scan/codex";
import { nativeTranscriptSource } from "..";

for (const provider of ["claude", "codex"] as const) {
  test(`${provider} keeps published chat bindings readable while the replacement catalog is scanning`, async t => {
    const root = mkdtempSync(join(tmpdir(), `granttap-${provider}-continuity-`));
    const env = provider === "claude" ? "GRANTTAP_CLAUDE_PROJECTS_DIR" : "GRANTTAP_CODEX_SESSIONS_DIR";
    const prior = process.env[env];
    process.env[env] = root;
    t.after(() => {
      if (prior === undefined) delete process.env[env]; else process.env[env] = prior;
      rmSync(root, { recursive: true, force: true });
    });
    const path = join(root, "rollout-continuity.jsonl");
    const timestamp = new Date().toISOString();
    const row = provider === "claude"
      ? { type: "user", sessionId: "continuity", timestamp,
          message: { role: "user", content: "synthetic fixture" } }
      : { type: "session_meta", timestamp, payload: { id: "continuity" } };
    writeFileSync(path, JSON.stringify(row) + "\n");
    const read = provider === "claude" ? scanClaude : scanCodex;
    const refresh = provider === "claude" ? scanClaudeCooperatively : scanCodexCooperatively;
    const session = read(1).sessions[0]!;
    assert.ok(session);
    assert.equal(nativeTranscriptSource(session), path);
    const scanning = refresh(1);
    await setImmediate();
    const during = nativeTranscriptSource(session);
    await scanning;
    assert.equal(during, path, "Open-chat reads must retain the last complete source index");
    assert.equal(nativeTranscriptSource(session), path);
  });
}
