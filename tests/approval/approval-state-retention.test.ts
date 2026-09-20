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

test("legacy raw winner retention ignores past and future phone decidedAt clocks", async () => {
  const registry = await import("../../apps/bridge/src/approvals/state");
  const recordsDir = join(testConfigDir, "approval-records");
  mkdirSync(recordsDir, { recursive: true });
  const base = Date.now();
  const writeLegacyWinner = (
    requestId: string,
    sessionId: string,
    decidedAt: number,
  ) => {
    const digest = createHash("sha256").update(requestId).digest("hex").slice(0, 32);
    const request = {
      type: "approval.request" as const,
      requestId,
      agent: "cursor",
      kind: "permission" as const,
      tool: "Shell",
      title: "Legacy raw winner",
      command: "git status",
      sessionId,
      risk: "medium" as const,
      createdAt: base,
    };
    writeFileSync(join(recordsDir, `${digest}.json`), `${JSON.stringify({
      request,
      state: "pending",
      updatedAt: base,
    })}\n`);
    writeFileSync(join(recordsDir, `${digest}.winner`), `${JSON.stringify({
      type: "approval.decision",
      requestId,
      decision: "allow",
      sessionId,
      decidedBy: "legacy-phone",
      decidedAt,
    })}\n`);
    return request;
  };

  const pastId = `legacy-past-clock-${process.pid}-${base}`;
  const pastSession = `legacy-past-session-${process.pid}-${base}`;
  const past = writeLegacyWinner(
    pastId,
    pastSession,
    base - 365 * 24 * 60 * 60_000,
  );
  const insideRetention = base + 16 * 60_000;
  assert.equal(
    registry.approvalsStatus(insideRetention).covered?.some((scope) =>
      scope.requestId === pastId && scope.sessionId === pastSession),
    true,
    "a past phone clock must not prune a locally fresh legacy winner",
  );
  assert.equal(registry.registerPendingApproval({
    ...past,
    title: "Conflicting reuse inside local retention",
    command: "rm -rf ./important-data",
    risk: "high",
  }, insideRetention).matched, false);

  const futureId = `legacy-future-clock-${process.pid}-${base}`;
  const futureSession = `legacy-future-session-${process.pid}-${base}`;
  const future = writeLegacyWinner(
    futureId,
    futureSession,
    base + 365 * 24 * 60 * 60_000,
  );
  const afterRetention = base + 25 * 60 * 60_000;
  const replacement = registry.registerPendingApproval({
    ...future,
    title: "Safe reuse after local retention",
    command: "npm test",
    createdAt: afterRetention,
  }, afterRetention);
  assert.equal(
    replacement.matched,
    true,
    "a future phone clock must not quarantine request-id reuse forever",
  );
  assert.ok(replacement.matched);
  assert.equal(replacement.newlyRegistered, true);
});
