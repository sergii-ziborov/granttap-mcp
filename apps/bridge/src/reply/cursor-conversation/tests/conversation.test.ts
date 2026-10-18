import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { runCursorResume } from "../../process/provider-headless";
import { abortProcesses, runningProcessCount } from "../../process";
import { runCursorConversation } from "../index";
import { saveRuntimeConfig } from "../../../config";
import type { ApprovalRequest } from "../../../../../../packages/protocol/schema";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";

function fixture(t: test.TestContext, mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "granttap-cursor-acp-"));
  const bin = join(root, "cursor-agent");
  const script = fileURLToPath(new URL("./native-fixture.cjs", import.meta.url));
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(bin, 0o700);
  const env = { GRANTTAP_CONFIG_DIR: join(root, "config"), GRANTTAP_CURSOR_STATE_DB: join(root, "missing.db"),
    GRANTTAP_CURSOR_AGENT_BIN: bin, CURSOR_FIXTURE_LOG: join(root, "calls"), CURSOR_FIXTURE_MARKER: join(root, "marker"), CURSOR_FIXTURE_MODE: mode };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  saveRuntimeConfig({ autoAcceptBySession: { "fixture-task": "ask" } });
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true }); });
  const session: SessionInfo = { sessionId: "fixture-task", agent: "cursor", cwd: root,
    state: "idle", startedAt: 1, lastActivityAt: 1, tokensLastTurn: 0, tokensSession: 0 };
  return { root, session, ...env };
}

test("a real Cursor control process waits for the phone question, one-call permission and plan answers", async t => {
  const f = fixture(t), requests: ApprovalRequest[] = [];
  const result = await runCursorConversation({ session: f.session, cwd: f.root, text: "Synthetic continuation", timeoutMs: 10_000,
    ask: async request => {
      requests.push(request);
      return { type: "approval.decision", requestId: request.requestId, sessionId: request.sessionId,
        decision: "allow", decidedAt: Date.now(), note: request.kind === "question" ? '{"Which action?":"Run tests"}' : undefined };
    } });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (result.ok) assert.equal(result.text, "Question answered; fixture completed.");
  assert.deepEqual(requests.map(request => request.tool), ["AskQuestion", "Shell", "Plan"]);
  assert(requests.every(request => request.sessionId === f.session.sessionId));
  assert.equal(readFileSync(f.CURSOR_FIXTURE_MARKER, "utf8"), "approved exactly once");
  assert(!readFileSync(f.CURSOR_FIXTURE_LOG, "utf8").includes("authenticate"));
});

test("an interactive resume failure cannot fork a fresh task or fall back to noninteractive execution", async t => {
  const f = fixture(t, "load-fail");
  const result = await runCursorResume(f.session, "Synthetic continuation", 5_000);
  assert.equal(result.ok, false);
  const calls = readFileSync(f.CURSOR_FIXTURE_LOG, "utf8");
  assert(calls.includes("session/load")); assert(!calls.includes("session/new")); assert(!calls.includes("session/prompt"));
});

test("Task Stop terminates only its Cursor process and aborts the pending phone form", async t => {
  const f = fixture(t, "wait"); let waiting: AbortSignal | undefined;
  const run = runCursorConversation({ session: f.session, cwd: f.root, text: "Synthetic continuation", timeoutMs: 10_000,
    ask: (request, signal) => { waiting = signal; return new Promise(resolve => signal.addEventListener("abort", () => resolve({
      type: "approval.decision", requestId: request.requestId, sessionId: request.sessionId,
      decision: "deny", decidedAt: Date.now(), decidedBy: "cancelled" }), { once: true })); } });
  for (let i = 0; i < 100 && !waiting; i++) await setTimeout(10);
  assert(waiting); assert.equal(runningProcessCount(f.session.sessionId), 1);
  assert.equal(abortProcesses(f.session.sessionId), 1);
  const result = await run; assert.equal(result.ok, false); assert.equal(waiting.aborted, true);
});

test("a new Cursor task remains stoppable through its pending delivery identity", async t => {
  const f = fixture(t, "wait"); let waiting: AbortSignal | undefined;
  const run = runCursorConversation({ cwd: f.root, text: "Synthetic task", operationKey: "pending-create", timeoutMs: 10_000,
    ask: (request, signal) => { waiting = signal; return new Promise(resolve => signal.addEventListener("abort", () => resolve({
      type: "approval.decision", requestId: request.requestId, sessionId: request.sessionId,
      decision: "deny", decidedAt: Date.now() }), { once: true })); } });
  for (let i = 0; i < 100 && !waiting; i++) await setTimeout(10);
  assert(waiting); assert.equal(runningProcessCount("pending-create"), 1);
  assert.equal(runningProcessCount("fixture-task"), 1);
  assert.equal(abortProcesses("pending-create"), 1);
  assert.equal((await run).ok, false); assert.equal(waiting.aborted, true);
});
