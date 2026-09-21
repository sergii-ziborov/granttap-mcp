/**
 * Auto-accept is configured from iOS only.
 *
 * The phone is the single source of truth: it sends `config.set`, the Mac
 * monitor persists it, and the hooks only ever read the stored level. This
 * pins that write path — default, pause, and a per-session override, plus the
 * fact that an unrelated config.set does not disturb auto-accept.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleConfigSet } from "../../apps/bridge/src/monitor";
import { autoAcceptLevelFor, loadRuntimeConfig } from "../../apps/bridge/src/config";

function withConfigDir(t: { after: (fn: () => void) => void }): void {
  const dir = mkdtempSync(join(tmpdir(), "granttap-ios-config-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = dir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("iOS sets the default auto-accept level", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptDefault: "full", createdAt: 0 });
  assert.equal(loadRuntimeConfig().autoAcceptDefault, "full");
});

test("iOS pauses and un-pauses auto-accept", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptPaused: true, createdAt: 0 });
  assert.equal(loadRuntimeConfig().autoAcceptPaused, true);
  handleConfigSet({ type: "config.set", autoAcceptPaused: false, createdAt: 0 });
  assert.equal(loadRuntimeConfig().autoAcceptPaused, false);
});

test("iOS sets and clears a per-session override", (t) => {
  withConfigDir(t);
  handleConfigSet({
    type: "config.set",
    autoAcceptSession: { sessionId: "chat-a", level: "safe" },
    createdAt: 0,
  });
  assert.equal(loadRuntimeConfig().autoAcceptBySession["chat-a"], "safe");

  handleConfigSet({
    type: "config.set",
    autoAcceptSession: { sessionId: "chat-a", level: null },
    createdAt: 0,
  });
  assert.equal(loadRuntimeConfig().autoAcceptBySession["chat-a"], undefined);
});

test("iOS sets and clears a per-project auto-accept", (t) => {
  withConfigDir(t);
  handleConfigSet({
    type: "config.set",
    autoAcceptProject: { projectId: "mesh-project", level: "safe" },
    createdAt: 0,
  });
  assert.equal(loadRuntimeConfig().autoAcceptByProject["mesh-project"], "safe");

  handleConfigSet({
    type: "config.set",
    autoAcceptProject: { projectId: "mesh-project", level: null },
    createdAt: 0,
  });
  assert.equal(loadRuntimeConfig().autoAcceptByProject["mesh-project"], undefined);
});

test("a Project auto-accept covers chats bound in Mesh", (t) => {
  withConfigDir(t);
  handleConfigSet({
    type: "config.set",
    autoAcceptDefault: "ask",
    autoAcceptProject: { projectId: "proj", level: "except_push" },
    createdAt: 0,
  });
  writeFileSync(join(process.env.GRANTTAP_CONFIG_DIR!, "project-mesh.json"), JSON.stringify({
    version: 1,
    projects: [{
      projectId: "proj", name: "GrantTap",
      canonicalRepositoryId: "github.com/x/y", createdAt: 1,
    }],
    tasks: [{
      taskId: "task", projectId: "proj", title: "Work", goal: "Ship",
      state: "working", createdAt: 1, updatedAt: 1,
    }],
    executions: [{
      taskId: "task", sessionId: "chat", provider: "cursor",
      computerId: "mac", workspace: "/repo", startedAt: 1,
    }],
  }));
  assert.equal(autoAcceptLevelFor("chat"), "except_push");
  assert.equal(autoAcceptLevelFor("other"), "ask");
});

test("a Mesh chat never inherits the machine auto-accept default", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptDefault: "full", createdAt: 0 });
  writeFileSync(join(process.env.GRANTTAP_CONFIG_DIR!, "project-mesh.json"), JSON.stringify({
    version: 1,
    projects: [{ projectId: "proj", name: "GrantTap", createdAt: 1 }],
    tasks: [{
      taskId: "task", projectId: "proj", title: "Work", goal: "Ship",
      state: "working", createdAt: 1, updatedAt: 1,
    }],
    executions: [{
      taskId: "task", sessionId: "mesh-chat", provider: "codex",
      computerId: "mac", workspace: "/repo", startedAt: 1,
    }],
  }));
  assert.equal(autoAcceptLevelFor("mesh-chat"), "ask");
  assert.equal(autoAcceptLevelFor("standalone-chat"), "full");
});

test("an unrelated config.set leaves auto-accept intact", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptDefault: "except_push", createdAt: 0 });
  // Toggling gating for one chat must not wipe the level the phone set.
  handleConfigSet({ type: "config.set", excludeSession: "chat-z", createdAt: 0 });
  const rc = loadRuntimeConfig();
  assert.equal(rc.autoAcceptDefault, "except_push");
  assert.ok(rc.excludedSessions.includes("chat-z"));
});

test("the phone can turn Cortex Loom compilation on without touching Mesh", (t) => {
  withConfigDir(t);
  assert.equal(loadRuntimeConfig().contextCompilerEnabled, false);
  handleConfigSet({ type: "config.set", contextCompilerEnabled: true, createdAt: 0 });
  assert.equal(loadRuntimeConfig().contextCompilerEnabled, true);
  assert.equal(loadRuntimeConfig().meshEnabled, true);
});
