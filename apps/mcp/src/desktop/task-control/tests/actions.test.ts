import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blockedSessionCapability, loadRuntimeConfig } from "../../../../../bridge/src/config";
import { runProcess, runningProcessCount, STOPPED_ERROR } from "../../../../../bridge/src/reply/process";
import { desktopTaskControl } from "../index";
import { desktopTaskPreferences } from "../preferences";

test("native controls persist the hold, stop the exact running delivery, and resume without a relay", async t => {
  const f = fixture(t);
  const running = runProcess(process.execPath, ["-e", "setInterval(() => {},1000)"],
    f.root, 5_000, () => ({ ok: true, text: "Unexpected" }), undefined, "s");
  for (let i = 0; i < 30 && !runningProcessCount("s"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runningProcessCount("s"), 1);
  assert.equal(await desktopTaskControl({ ...f.query, action: "pause" }, { ...f.options, endpointId: "remote" }), undefined);
  assert.equal(runningProcessCount("s"), 1);
  const held = await desktopTaskControl({ ...f.query, action: "pause" }, f.options);
  assert.equal(held?.result?.ok, true);
  assert.match(held?.result?.message ?? "", /Stop requested.*not yet confirmed/);
  assert.deepEqual(await running, { ok: false, error: STOPPED_ERROR });
  assert.deepEqual(loadRuntimeConfig().pausedSessions, ["s"]);
  assert.equal(blockedSessionCapability("s", "Bash", {})?.kind, "session");
  const resumed = await desktopTaskControl({ ...f.query, action: "resume", continue: false }, f.options);
  assert.equal(resumed?.result?.action, "resume");
  assert.deepEqual(loadRuntimeConfig().pausedSessions, []);
  assert.equal(await desktopTaskControl({ ...f.query, action: "stop" }, f.options), undefined);
  assert.equal(await desktopTaskControl({ ...f.query, project_id: "other", action: "pause" }, f.options), undefined);
  const compact = await desktopTaskControl({ ...f.query, action: "compact" }, f.options);
  assert.equal(compact?.result?.type, "session.compact.result");
  assert.equal(compact?.result?.ok, false, "a missing native session cannot claim a successful compaction");
});

test("native preferences use durable scoped approval and access settings and confirm machine policy", t => {
  const f = fixture(t);
  const read = () => desktopTaskPreferences(f.query, f.options);
  assert.equal(read()?.level, "ask");
  const full = desktopTaskPreferences({ ...f.query, auto_accept_level: "full", authorize_project_ask: true,
    expected_policy_revision: 0 }, f.options);
  assert.equal(full?.accepted, true);
  assert.equal(read()?.level, "full");
  const stale = desktopTaskPreferences({ ...f.query, auto_accept_level: "except_push", authorize_project_ask: true,
    expected_policy_revision: 9 }, f.options);
  assert.equal(stale?.accepted, false);
  assert.equal(read()?.level, "full", "a rejected policy cannot silently change the stored rule");
  assert.equal(desktopTaskPreferences({ ...f.query, access_level: "read-only" }, f.options)?.accepted, true);
  assert.equal(read()?.access_level, "read-only");
  desktopTaskPreferences({ ...f.query, shell_allowed: false, mcp: { name: "github", allowed: false },
    skill: { name: "review", allowed: false } }, f.options);
  assert.equal(read()?.shell_allowed, false);
  assert.deepEqual(read()?.mcp_disabled, ["github"]);
  assert.deepEqual(read()?.skills_disabled, ["review"]);
  desktopTaskPreferences({ ...f.query, excluded: true }, f.options);
  assert.equal(read()?.excluded, true);
  desktopTaskPreferences({ ...f.query, auto_accept_level: "ask" }, f.options);
  assert.equal(read()?.excluded, false);
  assert.equal(read()?.level, "ask");
  assert.equal(desktopTaskPreferences(f.query, { ...f.options, endpointId: "other" }), undefined);
  assert.equal(desktopTaskPreferences({ ...f.query, access_level: "bogus" }, f.options), undefined);
  assert.equal(desktopTaskPreferences({ ...f.query, excluded: true, auto_accept_level: "full" }, f.options), undefined);
});

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-native-control-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".git"));
  const storePath = join(root, "project-mesh.json");
  writeFileSync(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "p", name: "Synthetic", createdAt: 1 }],
    tasks: [{ taskId: "t", projectId: "p", title: "Synthetic", goal: "Synthetic", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "t", sessionId: "s", provider: "codex", computerId: "local", workspace: root, startedAt: 1 }],
  }));
  return { root, options: { storePath, endpointId: "local" }, query: { project_id: "p", task_id: "t", session_id: "s" } };
}
