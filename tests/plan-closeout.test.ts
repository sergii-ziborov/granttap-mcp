import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Payload } from "../packages/protocol/schema";
import { applyConfigSet } from "../apps/bridge/src/config-commands";
import { evaluateCreateTask } from "../apps/bridge/src/mesh/create-task";
import {
  currentInstanceEpoch, pairingKeysPresent, recoverInstanceAfterRestore, remintInstanceEpoch,
} from "../apps/bridge/src/instance-epoch";
import { parseInviteArgs, readInvite } from "../apps/bridge/src/mesh/invite-source";
import { affectedRecipients } from "../apps/bridge/src/mesh/affected-recipients";
import { persistBroadcast, recordTargetState, loadBroadcast } from "../apps/bridge/src/mesh/broadcast-ledger";
import { capabilityManifest } from "../apps/bridge/src/mesh/capability-manifest";
import { renderContextDelta } from "../apps/bridge/src/mesh/context-delta";
import { recordDelegation } from "../apps/bridge/src/mesh/delegation-loop";
import { advanceBroadcast, planBroadcast } from "../apps/bridge/src/mesh/delivery";
import { aliasFor, endpointIdFromAlias, setDeviceAlias } from "../apps/bridge/src/mesh/device-alias";
import {
  admitNewTask,
  applyHostGrant,
  loadExecutionPolicy,
  rememberExecutionPolicy,
  revokeExecutionPolicy,
} from "../apps/bridge/src/mesh/execution-policy";
import { renderCompactProjectContext } from "../apps/bridge/src/mesh/project-context";
import type { ScopedMeshView } from "../apps/bridge/src/mesh/scoped-view";
import { dueQueuedTasks, enqueuePinnedTask } from "../apps/bridge/src/mesh/task-queue";
import {
  ciphertextFingerprint, loadReplayFingerprints, saveReplayFingerprints,
} from "../packages/core/replay-store";

function isolate(): void {
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-plan-"));
}

function view(): ScopedMeshView {
  return {
    schema: "granttap.mesh-scope.v1",
    generatedAt: 1,
    execution: {
      taskId: "task-1", sessionId: "session-1", provider: "cursor",
      computerId: "mac-1", workspace: "/tmp/repo", startedAt: 1,
    },
    project: { projectId: "project-1", name: "GrantTap", canonicalRepositoryId: "repo", createdAt: 1 },
    task: {
      taskId: "task-1", projectId: "project-1", title: "Pin", goal: "Stay on one host",
      state: "working", createdAt: 1, updatedAt: 1,
    },
    peerTasks: [],
    executions: [{
      taskId: "task-1", sessionId: "session-1", provider: "cursor",
      computerId: "mac-1", workspace: "/tmp/repo", startedAt: 1,
    }],
    claims: [{
      claimId: "claim-1", projectId: "project-1", taskId: "task-1",
      ownerSessionId: "session-1", resource: "src/a.ts", mode: "claim", createdAt: 1, expiresAt: 2,
    }],
    neighbours: [],
    peers: [],
    otherSide: [],
    dependencies: [{ taskId: "task-2", dependsOnTaskId: "task-1", createdAt: 1 }],
    events: [
      {
        type: "mesh.event", sessionId: "task-1", eventId: "e1", projectId: "project-1",
        taskId: "task-1", sourceSessionId: "session-1", eventType: "TASK_PROGRESS",
        createdAt: 1, payload: { summary: "started" },
      },
      {
        type: "mesh.event", sessionId: "task-1", eventId: "e2", projectId: "project-1",
        taskId: "task-1", sourceSessionId: "session-1", eventType: "AGENT_ANSWER",
        createdAt: 2, payload: { answer: "use the pinned host" },
      },
    ],
    allowedEventTypes: [],
  };
}

test("S03 later config cannot be overtaken by an earlier baseRevision", () => {
  isolate();
  applyConfigSet({
    type: "config.set", meshEnabled: false, createdAt: 1, operationId: "first-op", baseRevision: 0,
  }, 1_000);
  const stale = applyConfigSet({
    type: "config.set", meshEnabled: true, createdAt: 2, operationId: "late-op", baseRevision: 0,
  }, 2_000);
  assert.deepEqual(stale, { kind: "rejected", reason: "conflict" });
});

test("S05 / E6 a reminted instance rejects the previous epoch", () => {
  isolate();
  const epoch = currentInstanceEpoch();
  remintInstanceEpoch();
  const result = applyConfigSet({
    type: "config.set",
    meshEnabled: false,
    createdAt: 1,
    operationId: "after-restore",
    instanceEpoch: epoch,
  }, 1_000);
  assert.equal(result.kind === "rejected" ? result.reason : "", "stale_instance");
});

test("S07 / S08 revoke and queue are explicit, not a silent fallback", () => {
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned", targetEndpointId: "mac-a", revision: 1,
    hostGrantStatus: "pending", offlineBehavior: "queueUntilDeadline",
  }, "mac-a");
  assert.deepEqual(admitNewTask({
    policy: loadExecutionPolicy("proj"), localEndpointId: "mac-a", hostOnline: false, now: 10,
  }), { ok: true, queued: true, deadline: 10 });
  revokeExecutionPolicy("proj");
  assert.deepEqual(admitNewTask({
    policy: loadExecutionPolicy("proj"), localEndpointId: "mac-a", hostOnline: true,
  }), { ok: false, reason: "host_unavailable" });
});

test("E3 host grant is applied only by the target endpoint", () => {
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned", targetEndpointId: "mac-b", revision: 4,
    hostGrantStatus: "pending", offlineBehavior: "reject",
  }, "mac-a");
  assert.equal(applyHostGrant("proj", "applied", 4, "mac-a")?.hostGrantStatus, "pending");
  isolate();
  rememberExecutionPolicy("proj", {
    mode: "pinned", targetEndpointId: "mac-a", revision: 4,
    hostGrantStatus: "pending", offlineBehavior: "reject",
  }, "mac-b");
  assert.equal(applyHostGrant("proj", "applied", 4, "mac-a")?.hostGrantStatus, "applied");
});

test("U02 a display alias is never a routing key", () => {
  isolate();
  setDeviceAlias("proj", "mac-a", "Studio");
  assert.equal(aliasFor("proj", "mac-a"), "Studio");
  assert.equal(endpointIdFromAlias("proj", "Studio"), undefined);
});

test("E5 delegation stops after two hops", () => {
  isolate();
  assert.equal(recordDelegation({ operationId: "op-a" }).ok, true);
  assert.equal(recordDelegation({ operationId: "op-b", parentSessionId: "op-a" }).ok, true);
  assert.equal(recordDelegation({ operationId: "op-c", parentSessionId: "op-b" }).ok, true);
  assert.deepEqual(recordDelegation({ operationId: "op-d", parentSessionId: "op-c" }), {
    ok: false, reason: "loop",
  });
});

test("M-01 broadcast ledger keeps a state per target", () => {
  isolate();
  const planned = planBroadcast([
    { executionId: "a", canWrite: true, paused: false, online: true },
    { executionId: "b", canWrite: true, paused: false, online: false },
  ]);
  persistBroadcast("op-cast", planned);
  recordTargetState("op-cast", "a", "acknowledged");
  assert.deepEqual(loadBroadcast("op-cast").map((item) => item.state), ["acknowledged", "offline"]);
  assert.equal(advanceBroadcast(planned, "b", "expired")[1]?.state, "expired");
});

test("M-02 affected recipients come from claims and dependencies and still need confirm", () => {
  const result = affectedRecipients({
    executions: [
      { sessionId: "s1", taskId: "task-1" },
      { sessionId: "s2", taskId: "task-2" },
    ],
    claims: [{ ownerSessionId: "s3", resource: "src/a.ts", taskId: "task-3" }],
    dependencies: [{ taskId: "task-2", dependsOnTaskId: "task-1" }],
  }, { taskId: "task-1", resources: ["src/a.ts"] });
  assert.equal(result.confirmRequired, true);
  assert.deepEqual(result.recipients.map((item) => item.sessionId).sort(), ["s1", "s2", "s3"]);
});

test("M-03/M-04 skill inventory hashes the same desired and actual rows", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-skills-"));
  mkdirSync(join(root, ".cursor", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(root, ".cursor", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo skill\n---\nbody\n",
  );
  const manifest = capabilityManifest([join(root, "src", "a.ts")]);
  assert.equal(manifest.desired[0]?.name, "demo");
  assert.equal(manifest.actual[0]?.name, "demo");
  assert.equal(manifest.matched, true);
  assert.equal(manifest.digest.length, 64);
});

test("M-05/M-06 decisions stay in compact context; unknown cursor resets", () => {
  const compact = renderCompactProjectContext(view());
  assert.equal(compact.decisions[0]?.eventId, "e2");
  const delta = renderContextDelta(view(), { lastEventId: "e1" });
  assert.equal(delta.mode, "delta");
  if (delta.mode === "delta") assert.deepEqual(delta.events.map((item) => item.eventId), ["e2"]);
  const reset = renderContextDelta(view(), { lastEventId: "missing" });
  assert.equal("reason" in reset ? reset.reason : "", "unknown_cursor");
});

test("E5 invite is read from a file or stdin flag, not from extra argv noise", () => {
  assert.deepEqual(parseInviteArgs(["--file", "/tmp/invite.txt"]), { kind: "file", path: "/tmp/invite.txt" });
  assert.deepEqual(parseInviteArgs(["-"]), { kind: "stdin" });
  assert.equal(parseInviteArgs(["one", "two"]).kind, "error");
  const file = join(mkdtempSync(join(tmpdir(), "granttap-invite-")), "invite.txt");
  writeFileSync(file, "granttap://mesh-invite?v=1\n");
  assert.equal(readInvite({ kind: "file", path: file }), "granttap://mesh-invite?v=1");
});

test("create-task refuses an unpublished workspace instead of guessing a host", () => {
  isolate();
  const refused = evaluateCreateTask({ cwd: "/no/such/workspace", agent: "codex" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "unknown_workspace");
});

test("a restore without an epoch file mints a new authority", () => {
  isolate();
  assert.equal(pairingKeysPresent(), false);
  const first = recoverInstanceAfterRestore();
  assert.equal(first.epoch, currentInstanceEpoch());
  isolate();
  writeFileSync(join(process.env.GRANTTAP_CONFIG_DIR!, "machine.json"), "{}\n");
  const restored = recoverInstanceAfterRestore();
  assert.equal(restored.epoch.length, 32);
});

test("queued tasks expire instead of starting after the deadline", () => {
  isolate();
  enqueuePinnedTask({
    operationId: "q1", projectId: "proj", text: "do", cwd: "/tmp", agent: "codex",
  }, 1);
  assert.equal(dueQueuedTasks(1 + 25 * 60 * 60_000).length, 0);
});

test("replay fingerprints ignore a missing path and keep a bounded file", () => {
  isolate();
  assert.equal(ciphertextFingerprint("n", "b").length > 10, true);
  assert.deepEqual(loadReplayFingerprints(undefined), []);
  saveReplayFingerprints(undefined, ["x"]);
  const path = join(process.env.GRANTTAP_CONFIG_DIR!, "replay.json");
  saveReplayFingerprints(path, ["one", "two"]);
  assert.deepEqual(loadReplayFingerprints(path), ["one", "two"]);
  assert.deepEqual(loadReplayFingerprints(join(process.env.GRANTTAP_CONFIG_DIR!, "missing.json")), []);
});

test("project.task.create is a distinct payload from user.message", () => {
  const created = Payload.parse({
    type: "project.task.create",
    operationId: "create-01",
    text: "Fix pairing",
    cwd: "/tmp/repo",
    createdAt: 1,
  });
  assert.equal(created.type, "project.task.create");
  const grant = Payload.parse({
    type: "project.execution.host-grant",
    projectId: "proj",
    grant: "applied",
    revision: 1,
    createdAt: 1,
  });
  assert.equal(grant.type, "project.execution.host-grant");
});
