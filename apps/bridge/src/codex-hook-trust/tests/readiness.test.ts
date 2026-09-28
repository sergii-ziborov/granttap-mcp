import assert from "node:assert/strict";
import test from "node:test";
import { projectCodexHooks, ownedHookCommands, codexPolicyReady } from "../index";
import { providerStatuses } from "../../../../mcp/src/status/provider-status";

const commands = ownedHookCommands();
function row(eventName = "preToolUse", changes: Record<string, unknown> = {}) {
  return { key: eventName, eventName, command: commands[eventName === "preToolUse" ? "policy" : "permission"],
    handlerType: "command", source: "user", sourcePath: "/fixture/config.toml", matcher: ".*",
    timeoutSec: eventName === "preToolUse" ? 30 : 120, enabled: true, isManaged: false,
    currentHash: "a".repeat(64), trustStatus: "trusted", ...changes };
}
function report(rows: unknown[], errors: unknown[] = []) {
  return { data: [{ cwd: "/fixture", hooks: rows, errors, warnings: [] }] };
}

test("native current-hash trust controls readiness independently of configuration", () => {
  const hooks = projectCodexHooks(report([row(), row("permissionRequest", { trustStatus: "modified" })]));
  assert.equal(hooks[0]?.trustStatus, "trusted");
  assert.equal(hooks[1]?.trustStatus, "modified");
  assert.equal(codexPolicyReady(hooks), true);
  const statuses = providerStatuses({ cursor: { installed: false, hookConfigured: false }, paired: true,
    monitor: { configured: true, running: true }, integrations: [
      { agent: "codex", installed: true, hookConfigured: true, hooks, hooksCheckedAt: Date.now() },
    ] });
  const codex = statuses.find(x => x.id === "codex")!;
  assert.equal(codex.status, "action_required");
  assert.match(codex.detail, /PermissionRequest.*review/);
  assert.equal(codex.hooks?.length, 2);
});

test("disabled, missing, invalid, and foreign hooks never claim policy enforcement", () => {
  for (const changes of [{ enabled: false }, { trustStatus: "untrusted" }, { trustStatus: "modified" },
    { trustStatus: "future" }, { matcher: "Bash" }, { timeoutSec: 1 }, { source: "project" },
    { command: `echo unsafe; ${commands.policy}` }, { currentHash: "" }]) {
    const hooks = projectCodexHooks(report([row("preToolUse", changes), row("permissionRequest")]));
    assert.equal(codexPolicyReady(hooks), false, JSON.stringify(changes));
  }
  assert.equal(codexPolicyReady(undefined), false);
  assert.equal(codexPolicyReady(projectCodexHooks(report([], ["malformed config"]))), false);
  assert.equal(codexPolicyReady(projectCodexHooks({})), false);
});

test("a fully trusted and enabled integration becomes connected; unknown stays unknown", () => {
  const readiness = { cursor: { installed: false, hookConfigured: false }, paired: true,
    monitor: { configured: true, running: true } };
  const configured = { agent: "codex" as const, installed: true, hookConfigured: true };
  const hooks = projectCodexHooks(report([row(), row("permissionRequest")]));
  assert.equal(providerStatuses({ ...readiness, integrations: [{ ...configured, hooks,
    hooksCheckedAt: Date.now() }] }).find(x => x.id === "codex")?.status, "connected");
  assert.match(providerStatuses({ ...readiness, integrations: [configured] })
    .find(x => x.id === "codex")?.detail ?? "", /not confirmed/);
});
