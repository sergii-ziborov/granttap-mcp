import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { testConfigDir, outcomeChild, raceDecisionAgainstTerminal } from "../support/approval/approval-state-race-fixtures";

test("Allow-vs-Deny race is atomic first-decision-wins across processes", async () => {
  const {
    approvalsStatus,
    registerPendingApproval,
    resolvedApprovalDecision,
  } = await import("../../apps/bridge/src/approvals/state");
  const suffix = `${process.pid}-${Date.now()}`;
  const requestId = `race-request-${suffix}`;
  const sessionId = `race-session-${suffix}`;
  registerPendingApproval({
    type: "approval.request",
    requestId,
    agent: "granttap",
    kind: "permission",
    tool: "ask_yes_no",
    title: "Atomic approval race",
    sessionId,
    risk: "medium",
    createdAt: Date.now(),
  });

  const startPath = join(testConfigDir, `race-${suffix}.start`);
  const allow = outcomeChild(
    "allow",
    requestId,
    sessionId,
    join(testConfigDir, `race-${suffix}.allow.ready`),
    startPath,
  );
  const deny = outcomeChild(
    "deny",
    requestId,
    sessionId,
    join(testConfigDir, `race-${suffix}.deny.ready`),
    startPath,
  );
  await Promise.all([allow.ready, deny.ready]);
  writeFileSync(startPath, "go");
  const results = await Promise.all([allow.result, deny.result]);

  assert.equal(
    results.filter((result) => result.newlyResolved === true).length,
    1,
    "exactly one process owns the atomic winner",
  );
  const winner = resolvedApprovalDecision(requestId, sessionId);
  assert.ok(winner);
  assert.ok(winner.decision === "allow" || winner.decision === "deny");
  assert.ok(results.every((result) => result.matched === true));
  assert.deepEqual(
    results.map(
      (result) => (result.decision as { decision?: unknown } | undefined)?.decision,
    ),
    [winner.decision, winner.decision],
    "both processes converge on the immutable winner, including the losing tap",
  );
  assert.equal(
    approvalsStatus().pending.some((request) => request.requestId === requestId),
    false,
    "a stale advisory record cannot resurrect the atomic winner",
  );
});

test("decision-vs-cancel is one atomic cross-process outcome", async () => {
  await raceDecisionAgainstTerminal("cancelled");
});

test("decision-vs-expire is one atomic cross-process outcome", async () => {
  await raceDecisionAgainstTerminal("expired");
});

test("durable winners are exact-session and cannot survive a reused request generation", async () => {
  const {
    acceptApprovalDecision,
    registerPendingApproval,
    resolvedApprovalDecision,
  } = await import("../../apps/bridge/src/approvals/state");
  const requestId = `generation-request-${process.pid}-${Date.now()}`;
  const sessionId = `generation-session-${process.pid}-${Date.now()}`;
  const base = Date.now();
  const request = {
    type: "approval.request" as const,
    requestId,
    agent: "granttap",
    kind: "permission" as const,
    tool: "ask_yes_no",
    title: "Generation-safe approval",
    sessionId,
    risk: "medium" as const,
    createdAt: base,
  };
  const firstRegistration = registerPendingApproval(request, base);
  assert.equal(firstRegistration.matched, true);
  assert.ok(firstRegistration.matched);
  assert.equal(acceptApprovalDecision({
    type: "approval.decision",
    requestId,
    decision: "allow",
    sessionId,
    decidedBy: "first-generation",
    decidedAt: base + 1,
  }, base + 1, firstRegistration.handle).newlyResolved, true);
  assert.equal(
    resolvedApprovalDecision(requestId, "foreign-session"),
    null,
    "durable lookup must require the exact expected session",
  );

  const nextGenerationAt = base + 25 * 60 * 60_000;
  const secondRegistration = registerPendingApproval(
    { ...request, createdAt: nextGenerationAt },
    nextGenerationAt,
  );
  assert.equal(secondRegistration.matched, true);
  assert.ok(secondRegistration.matched);
  assert.equal(secondRegistration.newlyRegistered, true);
  assert.notEqual(secondRegistration.handle.generation, firstRegistration.handle.generation);
  assert.equal(
    resolvedApprovalDecision(requestId, sessionId, secondRegistration.handle),
    null,
    "the first generation's winner must not resolve a reused request id",
  );
  assert.equal(acceptApprovalDecision({
    type: "approval.decision",
    requestId,
    decision: "allow",
    sessionId,
    decidedBy: "late-first-generation-listener",
    decidedAt: nextGenerationAt + 1,
  }, nextGenerationAt + 1, firstRegistration.handle).matched, false);
  assert.equal(acceptApprovalDecision({
    type: "approval.decision",
    requestId,
    decision: "deny",
    sessionId,
    decidedBy: "second-generation",
    decidedAt: nextGenerationAt + 2,
  }, nextGenerationAt + 2, secondRegistration.handle).newlyResolved, true);
  assert.equal(
    resolvedApprovalDecision(requestId, sessionId, secondRegistration.handle)?.decision,
    "deny",
  );
});

test("winner over a raw-pending advisory remains terminal after fifteen minutes", async () => {
  const {
    acceptApprovalDecision,
    approvalsStatus,
    registerPendingApproval,
    resolvedApprovalDecision,
  } = await import("../../apps/bridge/src/approvals/state");
  const base = Date.now();
  const requestId = `pending-tombstone-${process.pid}-${base}`;
  const sessionId = `pending-tombstone-session-${process.pid}-${base}`;
  registerPendingApproval({
    type: "approval.request",
    requestId,
    agent: "granttap",
    kind: "permission",
    tool: "ask_yes_no",
    title: "Retain the crash-recoverable winner",
    sessionId,
    risk: "medium",
    createdAt: base,
  }, base);
  assert.equal(acceptApprovalDecision({
    type: "approval.decision",
    requestId,
    decision: "allow",
    sessionId,
    decidedBy: "phone",
    decidedAt: base + 1,
  }, base + 1).newlyResolved, true);

  const digest = createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  const recordPath = join(testConfigDir, "approval-records", `${digest}.json`);
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  delete record.decision;
  writeFileSync(recordPath, `${JSON.stringify({ ...record, state: "pending" })}\n`);

  const afterFifteenMinutes = base + 16 * 60_000;
  const status = approvalsStatus(afterFifteenMinutes);
  assert.equal(resolvedApprovalDecision(requestId, sessionId)?.decision, "allow");
  assert.equal(status.pending.some((request) => request.requestId === requestId), false);
  assert.equal(
    status.covered?.some((scope) =>
      scope.requestId === requestId && scope.sessionId === sessionId),
    true,
  );
});

test("malicious persisted generation is rejected before winner path construction", async () => {
  const { acceptApprovalDecision } = await import("../../apps/bridge/src/approvals/state");
  const now = Date.now();
  const requestId = `malicious-generation-${process.pid}-${now}`;
  const sessionId = `malicious-generation-session-${process.pid}-${now}`;
  const digest = createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  const recordPath = join(testConfigDir, "approval-records", `${digest}.json`);
  writeFileSync(recordPath, `${JSON.stringify({
    request: {
      type: "approval.request",
      requestId,
      agent: "granttap",
      kind: "permission",
      tool: "ask_yes_no",
      title: "Reject unsafe generation",
      sessionId,
      risk: "medium",
      createdAt: now,
    },
    state: "pending",
    updatedAt: now,
    generation: "not-a-uuid/../../escape",
  })}\n`);

  let result: { matched?: boolean } | undefined;
  assert.doesNotThrow(() => {
    result = acceptApprovalDecision({
      type: "approval.decision",
      requestId,
      decision: "allow",
      sessionId,
      decidedBy: "attacker",
      decidedAt: now,
    });
  });
  assert.equal(result?.matched, false);
});

test("winner acceptedAt owns retention and a claimant never rewrites its advisory record", async () => {
  const {
    approvalsStatus,
    markApprovalTerminal,
    registerPendingApproval,
  } = await import("../../apps/bridge/src/approvals/state");
  const base = Date.now();
  const requestId = `no-stale-advisory-write-${process.pid}-${base}`;
  const sessionId = `no-stale-advisory-session-${process.pid}-${base}`;
  const firstRequest = {
    type: "approval.request" as const,
    requestId,
    agent: "cursor",
    kind: "permission" as const,
    tool: "Shell",
    title: "Original generation",
    command: "git status",
    sessionId,
    risk: "medium" as const,
    createdAt: base,
  };
  const first = registerPendingApproval(firstRequest, base);
  assert.ok(first.matched);
  const acceptedAt = base + 23 * 60 * 60_000;
  assert.equal(markApprovalTerminal(
    requestId,
    "cancelled",
    {
      decision: "allow",
      sessionId,
      decidedBy: "slow-old-process",
    },
    acceptedAt,
    first.handle,
  ).newlyResolved, true);

  const digest = createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  const rawRecord = JSON.parse(readFileSync(
    join(testConfigDir, "approval-records", `${digest}.json`),
    "utf8",
  )) as { state?: unknown; updatedAt?: unknown; decision?: unknown };
  assert.equal(rawRecord.state, "pending", "the immutable winner is the only post-CAS write");
  assert.equal(rawRecord.updatedAt, base);
  assert.equal(rawRecord.decision, undefined);

  const insideWinnerRetention = registerPendingApproval({
    ...firstRequest,
    title: "Conflicting generation",
    command: "rm -rf ./important-data",
    risk: "high",
  }, base + 25 * 60 * 60_000);
  assert.equal(
    insideWinnerRetention.matched,
    false,
    "retention must be measured from winner.acceptedAt, not the raw pending timestamp",
  );
  assert.equal(
    approvalsStatus(base + 25 * 60 * 60_000).covered?.some((scope) =>
      scope.requestId === requestId && scope.sessionId === sessionId),
    true,
    "status coverage must use the same winner.acceptedAt retention anchor",
  );

  const replacement = registerPendingApproval({
    ...firstRequest,
    title: "Replacement after winner retention",
    command: "npm test",
    createdAt: acceptedAt + 25 * 60 * 60_000,
  }, acceptedAt + 25 * 60 * 60_000);
  assert.ok(replacement.matched);
  assert.notEqual(replacement.handle.generation, first.handle.generation);
});

test("stale pending registration snapshot cannot cancel a replacement generation", async () => {
  const registry = await import("../../apps/bridge/src/approvals/state");
  assert.equal(
    typeof registry.pendingApprovalRegistrations,
    "function",
    "Cursor needs a request plus exact registration handle from one snapshot",
  );
  const base = Date.now();
  const requestId = `stale-cursor-after-shell-${process.pid}-${base}`;
  const sessionId = `stale-cursor-after-shell-session-${process.pid}-${base}`;
  registry.registerPendingApproval({
    type: "approval.request",
    requestId,
    agent: "cursor",
    kind: "permission",
    tool: "Shell",
    title: "Old Cursor command",
    command: "git status",
    sessionId,
    risk: "medium",
    createdAt: base,
  }, base);
  const stale = registry.pendingApprovalRegistrations(base)
    .find((item) => item.request.requestId === requestId);
  assert.ok(stale);

  const replacementAt = base + 25 * 60 * 60_000;
  const replacement = registry.registerPendingApproval({
    ...stale.request,
    title: "New Cursor command",
    command: "npm publish",
    risk: "high",
    createdAt: replacementAt,
  }, replacementAt);
  assert.ok(replacement.matched);
  const staleClaim = registry.markApprovalTerminal(
    requestId,
    "cancelled",
    {
      decision: "allow",
      decidedBy: "cursor-local",
      sessionId,
    },
    replacementAt + 1,
    stale.handle,
  );
  assert.equal(staleClaim.matched, false);
  assert.equal(
    registry.pendingApprovalRequests(replacementAt + 1)
      .some((request) => request.command === "npm publish"),
    true,
  );
});
