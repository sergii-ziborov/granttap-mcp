/**
 * The phone sends scoped auto-accept choices through `config.set`; the Mac
 * persists them, and hooks read the Project decision for Mesh executions.
 * Legacy machine defaults continue to apply only to standalone chats.
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

test("an ambiguous native session ID cannot borrow another Project's auto-accept", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptDefault: "full", createdAt: 0 });
  handleConfigSet({ type: "config.set", autoAcceptProject: { projectId: "one", level: "full" }, createdAt: 0 });
  writeFileSync(join(process.env.GRANTTAP_CONFIG_DIR!, "project-mesh.json"), JSON.stringify({
    version: 1,
    projects: ["one", "two"].map((projectId) => ({ projectId, name: projectId, createdAt: 1 })),
    tasks: ["one", "two"].map((projectId) => ({
      taskId: `task-${projectId}`, projectId, title: "Work", goal: "Ship",
      state: "working", createdAt: 1, updatedAt: 1,
    })),
    executions: ["one", "two"].map((projectId) => ({
      taskId: `task-${projectId}`, sessionId: "reused-native-id", provider: "claude",
      computerId: projectId, workspace: "/repo", startedAt: 1,
    })),
  }));
  assert.equal(autoAcceptLevelFor("reused-native-id"), "ask");
});

test("a reused native ID across providers cannot borrow a session override", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptProject: { projectId: "one", level: "full" }, createdAt: 0 });
  writeFileSync(join(process.env.GRANTTAP_CONFIG_DIR!, "project-mesh.json"), JSON.stringify({
    version: 1,
    projects: [{ projectId: "one", name: "One", createdAt: 1 }],
    tasks: ["a", "b"].map((id) => ({ taskId: id, projectId: "one", title: id,
      goal: id, state: "working", createdAt: 1, updatedAt: 1 })),
    executions: ["claude", "codex"].map((provider, index) => ({
      taskId: index === 0 ? "a" : "b", sessionId: "reused-native-id", provider,
      computerId: "mac", workspace: "/repo", startedAt: index + 1,
    })),
  }));
  assert.equal(autoAcceptLevelFor("reused-native-id"), "ask");
});

test("unreadable Mesh state fails auto-accept closed", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptDefault: "full", createdAt: 0 });
  writeFileSync(join(process.env.GRANTTAP_CONFIG_DIR!, "project-mesh.json"), "{invalid");
  assert.equal(autoAcceptLevelFor("possibly-mesh-chat"), "ask");
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
