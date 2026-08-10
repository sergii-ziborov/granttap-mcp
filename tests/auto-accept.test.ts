/**
 * Auto-accept is what keeps GrantTap from being a single point of failure.
 *
 * Without it, every gated tool call goes to the phone. A phone that is asleep,
 * offline, or simply not being looked at then stalls the agent for the full
 * approval timeout and hard-denies — the agent cannot run a command, edit a
 * file, or call an MCP tool until a human picks up the device.
 *
 * These tests pin the contract:
 *   - routine work is decided locally and never touches the relay
 *   - risky classes still escalate to the device
 *   - the level is honoured (paused / per-session / ask)
 *   - an unpaired machine keeps the agent's own prompts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPairing } from "../apps/bridge/src/config";

type Runtime = Record<string, unknown>;

async function deadRelayUrl(): Promise<string> {
  // Bound then closed: connecting refuses immediately instead of hanging, so a
  // test that reaches the relay fails fast and visibly.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `ws://127.0.0.1:${port}`;
}

/** Paired machine whose phone can never be reached. */
async function pairedButOffline(
  t: { after: (fn: () => void) => void },
  runtime: Runtime,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "granttap-auto-accept-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paired = createPairing(await deadRelayUrl());
  writeFileSync(join(dir, "machine.json"), JSON.stringify(paired.machineCfg));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ enabled: true, excludedSessions: [], ...runtime }),
  );
  return dir;
}

/** Same, with no machine.json at all. */
function unpaired(t: { after: (fn: () => void) => void }, runtime: Runtime): string {
  const dir = mkdtempSync(join(tmpdir(), "granttap-auto-accept-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ enabled: true, excludedSessions: [], ...runtime }),
  );
  return dir;
}

async function runClaudeHook(
  configDir: string,
  input: Record<string, unknown>,
): Promise<{ stdout: string; elapsedMs: number }> {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/bridge/src/bin/claude-hook.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, GRANTTAP_CONFIG_DIR: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  child.stdin.end(JSON.stringify(input));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(status, 0, stderr);
  return { stdout: stdout.trim(), elapsedMs: Date.now() - startedAt };
}

function decisionOf(stdout: string): string | undefined {
  if (!stdout) return undefined;
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  return parsed.hookSpecificOutput?.permissionDecision;
}

const routine = { tool_name: "Bash", tool_input: { command: "echo hi" } };
const risky = { tool_name: "Bash", tool_input: { command: "git push --force origin main" } };

test("routine work is allowed locally while the phone is unreachable", async (t) => {
  const dir = await pairedButOffline(t, { autoAcceptDefault: "except_push" });

  const { stdout, elapsedMs } = await runClaudeHook(dir, { session_id: "s1", ...routine });

  assert.equal(decisionOf(stdout), "allow");
  assert.match(stdout, /auto-accept/, "decision should say it was decided locally");
  // A relay round-trip is impossible here, so this also proves no phone was involved.
  assert.ok(elapsedMs < 30_000, `should not stall on the phone (took ${elapsedMs}ms)`);
});

test("a push still escalates instead of being auto-allowed", async (t) => {
  const dir = await pairedButOffline(t, { autoAcceptDefault: "except_push" });

  const { stdout } = await runClaudeHook(dir, { session_id: "s1", ...risky });

  assert.notEqual(decisionOf(stdout), "allow", "git push --force must reach a human");
});

test("level ask sends everything to the device", async (t) => {
  const dir = await pairedButOffline(t, { autoAcceptDefault: "ask" });

  const { stdout } = await runClaudeHook(dir, { session_id: "s1", ...routine });

  assert.notEqual(decisionOf(stdout), "allow");
});

test("pausing auto-accept overrides the configured level", async (t) => {
  const dir = await pairedButOffline(t, {
    autoAcceptDefault: "full",
    autoAcceptPaused: true,
  });

  const { stdout } = await runClaudeHook(dir, { session_id: "s1", ...routine });

  assert.notEqual(decisionOf(stdout), "allow");
});

test("a per-session level beats the default", async (t) => {
  const dir = await pairedButOffline(t, {
    autoAcceptDefault: "ask",
    autoAcceptBySession: { loud: "except_push" },
  });

  const quiet = await runClaudeHook(dir, { session_id: "quiet", ...routine });
  const loud = await runClaudeHook(dir, { session_id: "loud", ...routine });

  assert.notEqual(decisionOf(quiet.stdout), "allow", "default still asks");
  assert.equal(decisionOf(loud.stdout), "allow", "override auto-accepts");
});

test("an unpaired machine keeps the agent's own prompt", async (t) => {
  // Auto-accept must not override permissions for a product the user never
  // finished setting up.
  const dir = unpaired(t, { autoAcceptDefault: "full" });

  const { stdout } = await runClaudeHook(dir, { session_id: "s1", ...routine });

  assert.equal(decisionOf(stdout), "ask");
});
