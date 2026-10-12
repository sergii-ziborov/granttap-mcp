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
