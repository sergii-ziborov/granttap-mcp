import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyConfigSet } from "../../config/commands";
import { registerPendingApproval } from "../../approvals/state";
import { currentInstanceEpoch } from "../../host/instance-epoch";
import { rememberGovernedProject } from "../../policy/governed-projects";
import { taskAutomationLevel } from "..";
import type { ApprovalRequest, ConfigSet } from "../../../../../packages/protocol/schema";

test("a controller grants only the displayed pending chat and policy revision", t => {
  const dir = mkdtempSync(join(tmpdir(), "granttap-controller-grant-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = dir;
  t.after(() => { if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous; rmSync(dir, { recursive: true }); });
  const now = Date.now();
  const request: ApprovalRequest = { type: "approval.request", requestId: "permission",
    sessionId: "child-chat", projectId: "project", policyRevision: 3,
    agent: "claude", kind: "permission", tool: "Bash", title: "echo safe",
    command: "echo safe", risk: "low", createdAt: now };
  registerPendingApproval(request, now);
  rememberGovernedProject("project", 3, now);
  const command: ConfigSet = { type: "config.set", operationId: "grant",
    instanceEpoch: currentInstanceEpoch(), expiresAt: now + 60_000, createdAt: now,
    autoAcceptSession: { sessionId: "child-chat", level: "except_push",
      authorizeProjectAsk: true, expectedPolicyRevision: 3, approvalRequestId: "permission" } };
  assert.equal(applyConfigSet(command, now).kind, "applied");
  assert.equal(taskAutomationLevel("child-chat", "project", 3), "except_push");
  const clear = { ...command, operationId: "clear", autoAcceptSession: {
    sessionId: "child-chat", level: null } };
  assert.equal(applyConfigSet(clear, now).kind, "applied");
  assert.equal(taskAutomationLevel("child-chat", "project", 3), undefined);
  assert.equal(applyConfigSet({ ...command, operationId: "regrant" }, now).kind, "applied");
  rememberGovernedProject("project", 4, now);
  assert.deepEqual(applyConfigSet({ ...command, operationId: "stale" }, now),
    { kind: "rejected", reason: "policy_changed" });
  assert.deepEqual(applyConfigSet({ ...command, operationId: "wrong",
    autoAcceptSession: { ...command.autoAcceptSession!, sessionId: "other-chat" } }, now),
    { kind: "rejected", reason: "approval_unavailable" });
});

test("a request the hook left without a policy revision can still be granted, minutes after it was raised", t => {
  const dir = mkdtempSync(join(tmpdir(), "granttap-controller-grant-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = dir;
  t.after(() => { if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous; rmSync(dir, { recursive: true }); });
  const raised = Date.now() - 20 * 60_000;
  // As observed on 2026-11-11: projectId set, policyRevision absent, Project governed at revision 1.
  const request: ApprovalRequest = { type: "approval.request", requestId: "unstamped",
    sessionId: "spare-chat", projectId: "project", agent: "claude", kind: "permission", tool: "Bash",
    title: "ssh host 'echo ok'", command: "ssh host 'echo ok'", risk: "medium", createdAt: raised };
  registerPendingApproval(request, raised);
  rememberGovernedProject("project", 1, raised);
  const now = Date.now();
  const command: ConfigSet = { type: "config.set", operationId: "grant-unstamped",
    instanceEpoch: currentInstanceEpoch(), expiresAt: now + 60_000, createdAt: now,
    autoAcceptSession: { sessionId: "spare-chat", level: "except_push",
      authorizeProjectAsk: true, approvalRequestId: "unstamped" } };
  assert.equal(applyConfigSet(command, now).kind, "applied");
  assert.equal(taskAutomationLevel("spare-chat", "project", 1), "except_push", "bound to the revision in force");
  assert.deepEqual(applyConfigSet({ ...command, operationId: "claims-a-revision",
    autoAcceptSession: { ...command.autoAcceptSession!, expectedPolicyRevision: 7 } }, now),
    { kind: "rejected", reason: "policy_changed" }, "a revision the request never carried is still refused");
});
