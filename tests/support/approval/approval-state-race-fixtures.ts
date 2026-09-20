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

const previousConfigDir = process.env.GRANTTAP_CONFIG_DIR;

const testConfigDir = mkdtempSync(join(tmpdir(), "granttap-mcp-approval-race-"));

process.env.GRANTTAP_CONFIG_DIR = testConfigDir;

after(() => {
  if (previousConfigDir == null) delete process.env.GRANTTAP_CONFIG_DIR;
  else process.env.GRANTTAP_CONFIG_DIR = previousConfigDir;
  rmSync(testConfigDir, { recursive: true, force: true });
});

function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function outcomeChild(
  operation: "allow" | "deny" | "cancelled" | "expired",
  requestId: string,
  sessionId: string,
  readyPath: string,
  startPath: string,
): { ready: Promise<void>; result: Promise<Record<string, unknown>> } {
  const source = `
    import { existsSync, writeFileSync } from "node:fs";
    const state = new Int32Array(new SharedArrayBuffer(4));
    const registry = await import("./apps/bridge/src/approvals/state.ts");
    writeFileSync(process.env.READY_PATH, "ready");
    while (!existsSync(process.env.START_PATH)) Atomics.wait(state, 0, 0, 5);
    const operation = process.env.OPERATION;
    const result = operation === "allow" || operation === "deny"
      ? registry.acceptApprovalDecision({
          type: "approval.decision",
          requestId: process.env.REQUEST_ID,
          decision: operation,
          sessionId: process.env.SESSION_ID,
          decidedBy: "race-child",
          decidedAt: Number(process.env.DECIDED_AT),
        })
      : registry.markApprovalTerminal(
          process.env.REQUEST_ID,
          operation,
          {
            sessionId: process.env.SESSION_ID,
            decision: operation === "cancelled" ? "allow" : "deny",
            decidedBy: "race-child",
            note: operation === "cancelled" ? "ran locally" : "timed out",
          },
          Number(process.env.DECIDED_AT),
        );
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GRANTTAP_CONFIG_DIR: testConfigDir,
        READY_PATH: readyPath,
        START_PATH: startPath,
        REQUEST_ID: requestId,
        SESSION_ID: sessionId,
        OPERATION: operation,
        DECIDED_AT: String(Date.now()),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`decision child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`invalid decision child output ${stdout}: ${String(error)}`));
      }
    });
  });
  return { ready: waitForFile(readyPath), result };
}

async function raceDecisionAgainstTerminal(
  terminal: "cancelled" | "expired",
): Promise<void> {
  const {
    approvalsStatus,
    registerPendingApproval,
  } = await import("../../../apps/bridge/src/approvals/state");
  const suffix = `${terminal}-${process.pid}-${Date.now()}`;
  const requestId = `terminal-race-request-${suffix}`;
  const sessionId = `terminal-race-session-${suffix}`;
  registerPendingApproval({
    type: "approval.request",
    requestId,
    agent: "granttap",
    kind: "permission",
    tool: "ask_yes_no",
    title: `Decision versus ${terminal}`,
    sessionId,
    risk: "medium",
    createdAt: Date.now(),
  });

  const startPath = join(testConfigDir, `terminal-race-${suffix}.start`);
  const decision = outcomeChild(
    "allow",
    requestId,
    sessionId,
    join(testConfigDir, `terminal-race-${suffix}.decision.ready`),
    startPath,
  );
  const terminalOutcome = outcomeChild(
    terminal,
    requestId,
    sessionId,
    join(testConfigDir, `terminal-race-${suffix}.terminal.ready`),
    startPath,
  );
  await Promise.all([decision.ready, terminalOutcome.ready]);
  writeFileSync(startPath, "go");
  const results = await Promise.all([decision.result, terminalOutcome.result]);

  assert.equal(
    results.filter((result) => result.newlyResolved === true).length,
    1,
    "decision and terminal transition must share one atomic owner",
  );
  const outcomes = results.map((result) => result.outcome);
  assert.ok(outcomes[0], "the winning durable outcome must be returned");
  assert.deepEqual(
    outcomes,
    [outcomes[0], outcomes[0]],
    "the losing process must replay the exact decision/terminal winner",
  );
  assert.ok(results.every((result) => result.matched === true));
  assert.equal(
    approvalsStatus().pending.some((request) => request.requestId === requestId),
    false,
  );
}

export { testConfigDir, outcomeChild, raceDecisionAgainstTerminal };
