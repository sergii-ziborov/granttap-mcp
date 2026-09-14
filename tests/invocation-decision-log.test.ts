import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  invocationDecisionPath, recordProjectDecision, recentProjectDecisions,
} from "../apps/bridge/src/policy/decision-log";

test("two identical denials remain distinct exact-call events without private reasons", () => {
  const before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-decisions-"));
  try {
    for (const nativeCallId of ["call-1", "call-2"]) {
      recordProjectDecision("session", {
        at: 1_000, toolName: "Edit", reason: "private explanation",
        ruleId: "deny-edit", policyRevision: 3, provider: "claude", nativeCallId,
        artifactHash: "a".repeat(64),
      });
    }
    const sidecar = readFileSync(invocationDecisionPath("session"), "utf8");
    const rows = sidecar.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(rows.map((row) => row.nativeCallId), ["call-1", "call-2"]);
    assert.equal(sidecar.includes("private explanation"), false);
    assert.equal(rows[0]?.artifactHash, "a".repeat(64));
    assert.equal(recentProjectDecisions("session").length, 2);
  } finally {
    if (before == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = before;
  }
});
