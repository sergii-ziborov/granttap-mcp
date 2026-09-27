import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  admitNewTask,
  applyHostGrant,
  executionPoliciesPath,
  loadExecutionPolicy,
  rememberExecutionPolicy,
} from "../../apps/bridge/src/mesh/runtime/execution-policy";
import { loadConfigCommandState } from "../../apps/bridge/src/config/commands";

function isolate(): void {
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-exec-"));
}

test("a pinned host stays pending until its owner explicitly applies the grant", () => {
  isolate();
  const local = rememberExecutionPolicy("proj", {
    mode: "pinned",
    targetEndpointId: "mac-a",
    revision: 2,
    hostGrantStatus: "pending",
    offlineBehavior: "reject",
  }, "mac-a");
  assert.equal(local?.hostGrantStatus, "pending");
  assert.equal(applyHostGrant("proj", "applied", 2, "mac-a")?.hostGrantStatus, "applied");
  isolate();
  const remote = rememberExecutionPolicy("proj", {
    mode: "pinned",
    targetEndpointId: "mac-b",
    revision: 2,
    hostGrantStatus: "pending",
    offlineBehavior: "reject",
  }, "mac-a");
  assert.equal(remote?.hostGrantStatus, "pending");
  assert.equal(loadExecutionPolicy("proj")?.targetEndpointId, "mac-b");
});

test("pinned admission refuses the client machine and an unconfirmed host", () => {
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned",
    targetEndpointId: "mac-b",
    revision: 1,
    hostGrantStatus: "pending",
    offlineBehavior: "reject",
  }, "mac-a");
  assert.deepEqual(admitNewTask({
    policy: loadExecutionPolicy("proj"),
    localEndpointId: "mac-a",
    hostOnline: true,
  }), { ok: false, reason: "wrong_host" });

  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned",
    targetEndpointId: "mac-a",
    revision: 1,
    hostGrantStatus: "pending",
    offlineBehavior: "reject",
  }, "mac-b");
  assert.deepEqual(admitNewTask({
    policy: loadExecutionPolicy("proj"),
    localEndpointId: "mac-a",
    hostOnline: true,
  }), { ok: false, reason: "not_confirmed" });
});

test("two initiators on the confirmed host are admitted; a foreign model is not", () => {
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned",
    targetEndpointId: "mac-a",
    revision: 3,
    hostGrantStatus: "pending",
    offlineBehavior: "reject",
  }, "mac-a");
  applyHostGrant("proj", "applied", 3, "mac-a");
  const policy = loadExecutionPolicy("proj");
  assert.deepEqual(admitNewTask({
    policy, localEndpointId: "mac-a", hostOnline: true,
  }), { ok: true });
  assert.deepEqual(admitNewTask({
    policy, localEndpointId: "mac-a", hostOnline: true,
  }), { ok: true });
  assert.deepEqual(admitNewTask({
    policy, localEndpointId: "mac-a", hostOnline: true,
    model: "secret-model", allowedModels: ["sonnet"],
  }), { ok: false, reason: "model_not_allowed" });
});

test("offline pinned admission checks the model before promising a queued task", () => {
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned", targetEndpointId: "mac-a", revision: 4,
    hostGrantStatus: "pending", offlineBehavior: "queueUntilDeadline",
  }, "mac-a");
  applyHostGrant("proj", "applied", 4, "mac-a");
  assert.deepEqual(admitNewTask({
    policy: loadExecutionPolicy("proj"), localEndpointId: "mac-a", hostOnline: false,
    model: "foreign-model", allowedModels: ["approved-model"], now: 1,
  }), { ok: false, reason: "model_not_allowed" });
});

test("applying a pin requires fresh config.set commands", () => {
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned",
    targetEndpointId: "mac-a",
    revision: 1,
    hostGrantStatus: "pending",
    offlineBehavior: "reject",
  }, "mac-a");
  assert.equal(loadConfigCommandState().requireFreshCommands, true);
});

test("a damaged policy store cannot become an unconfigured Project or be overwritten", () => {
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned", targetEndpointId: "mac-a", revision: 5,
    hostGrantStatus: "pending", offlineBehavior: "reject",
  }, "mac-a");
  const path = executionPoliciesPath();
  writeFileSync(path, '{"policies": [');
  assert.throws(() => loadExecutionPolicy("proj"), /execution policy/i);
  assert.throws(() => rememberExecutionPolicy("other", undefined, "mac-a"), /execution policy/i);
  assert.equal(readFileSync(path, "utf8"), '{"policies": [');
});

test("an intentionally absent policy store remains a legacy unconfigured state", () => {
  isolate();
  assert.equal(loadExecutionPolicy("proj"), undefined);
});

test("a previously saved policy store cannot become legacy when its file disappears", () => {
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned", targetEndpointId: "mac-a", revision: 6,
    hostGrantStatus: "pending", offlineBehavior: "reject",
  }, "mac-a");
  unlinkSync(executionPoliciesPath());
  assert.throws(() => loadExecutionPolicy("proj"), /execution policy/i);
  assert.throws(() => rememberExecutionPolicy("other", undefined, "mac-a"), /execution policy/i);
});

test("reading an older policy store records its presence before later loss", () => {
  isolate();
  const path = executionPoliciesPath();
  writeFileSync(path, JSON.stringify({ policies: [{
    projectId: "older", mode: "distributed", revision: 1,
    hostGrantStatus: "none", offlineBehavior: "reject",
  }] }));
  assert.equal(loadExecutionPolicy("older")?.mode, "distributed");
  unlinkSync(path);
  assert.throws(() => loadExecutionPolicy("older"), /execution policy/i);
});

test("a distributed Project still checks an explicitly selected model", () => {
  assert.deepEqual(admitNewTask({
    policy: undefined, localEndpointId: "mac-a", hostOnline: true,
    model: "codex-only", allowedModels: [],
  }), { ok: false, reason: "model_not_allowed" });
});
