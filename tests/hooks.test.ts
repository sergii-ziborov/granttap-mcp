import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

async function runHook(script: string, stdin: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: process.cwd(),
    env: { ...process.env, GRANTTAP_CONFIG_DIR: "/definitely/not/a/pairing" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end(stdin);
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(status, 0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("malformed agent hook input fails closed before any relay fallback", async () => {
  const [codex, claude] = await Promise.all([
    runHook("apps/bridge/src/bin/codex-hook.ts", "not json"),
    runHook("apps/bridge/src/bin/claude-hook.ts", "not json"),
  ]);
  assert.equal(
    ((codex.hookSpecificOutput as { decision: { behavior: string } }).decision.behavior),
    "deny",
  );
  assert.equal(
    ((claude.hookSpecificOutput as { permissionDecision: string }).permissionDecision),
    "deny",
  );
});
