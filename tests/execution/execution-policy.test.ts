import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  admitNewTask,
  applyHostGrant,
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
