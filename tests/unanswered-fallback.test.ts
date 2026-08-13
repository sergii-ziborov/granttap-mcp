/**
 * A phone that never answers must not read as "the human said no".
 *
 * The device is attached and receives the card — it just never gets tapped.
 * That has to come back as `expired` and be handed to the agent's own prompt,
 * not reported as a denial.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { claudeToRequest } from "../apps/bridge/src/adapters";
import { isUnanswered, requestApproval } from "../apps/bridge/src/approval";
import { createPairing } from "../apps/bridge/src/config";

/**
 * Accepts the socket and then says nothing — a phone with the app attached and
 * the screen off. HTTP requests get a flat 404 so the Cloudflare card path
 * fails fast instead of hanging the test.
 */
async function silentRelay(): Promise<{
  url: string;
  connections: () => number;
  close: () => Promise<void>;
}> {
  const http: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http });
  let connections = 0;
  wss.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address === "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    connections: () => connections,
    close: async () => {
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const routine = { tool_name: "Bash", tool_input: { command: "echo hi" } };

test("a silent phone expires instead of denying", async (t) => {
  const relay = await silentRelay();
  t.after(() => relay.close());
  const paired = createPairing(relay.url);

  const decision = await requestApproval(paired.machineCfg, claudeToRequest(routine), {
    timeoutMs: 400,
  });

  assert.equal(decision.decision, "deny", "still fails closed for the caller");
  assert.equal(decision.decidedBy, "expired", "but marked unanswered, not a human deny");
  assert.equal(isUnanswered(decision), true);
});

test("isUnanswered separates no-answer from a real decision", () => {
  const base = { type: "approval.decision", requestId: "r1", decidedAt: 0 } as const;
  assert.equal(isUnanswered({ ...base, decision: "deny", decidedBy: "expired" }), true);
  assert.equal(isUnanswered({ ...base, decision: "deny", decidedBy: "unreachable" }), true);
  // A human tapping Deny on the phone or watch must still deny.
  assert.equal(isUnanswered({ ...base, decision: "deny", decidedBy: "phone" }), false);
  assert.equal(isUnanswered({ ...base, decision: "deny", decidedBy: "watch" }), false);
  assert.equal(isUnanswered({ ...base, decision: "allow", decidedBy: "expired" }), false);
});

test("claude hook abstains when the phone never answers", async (t) => {
  const relay = await silentRelay();
  t.after(() => relay.close());
  const paired = createPairing(relay.url);

  const dir = mkdtempSync(join(tmpdir(), "granttap-expired-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "machine.json"), JSON.stringify(paired.machineCfg));
  writeFileSync(
    join(dir, "config.json"),
    // `ask` so the call reaches the device instead of being auto-accepted.
    JSON.stringify({ enabled: true, excludedSessions: [], autoAcceptDefault: "ask" }),
  );

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/bridge/src/bin/claude-hook.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GRANTTAP_CONFIG_DIR: dir,
        GRANTTAP_APPROVAL_TIMEOUT_MS: "600",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  child.stdin.end(JSON.stringify({ session_id: "silent", ...routine }));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));

  assert.equal(status, 0, stderr);
  // Empty stdout = abstain: Claude falls back to its own permission prompt.
  assert.equal(stdout.trim(), "", `expected abstain, got ${stdout}`);
});

test("Claude bypassPermissions never creates a phone approval", async (t) => {
  const relay = await silentRelay();
  t.after(() => relay.close());
  const paired = createPairing(relay.url);
  const dir = mkdtempSync(join(tmpdir(), "granttap-bypass-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "machine.json"), JSON.stringify(paired.machineCfg));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ enabled: true, excludedSessions: [], autoAcceptDefault: "ask" }),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/bridge/src/bin/claude-hook.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, GRANTTAP_CONFIG_DIR: dir, GRANTTAP_APPROVAL_TIMEOUT_MS: "300" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stdin.end(JSON.stringify({
    session_id: "claude-bypass-session",
    permission_mode: "bypassPermissions",
    ...routine,
  }));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));

  assert.equal(status, 0);
  assert.equal(stdout.trim(), "", "Claude keeps its bypass permission mode");
  assert.equal(relay.connections(), 0, "GrantTap must not contact the phone for a bypassed call");
});
