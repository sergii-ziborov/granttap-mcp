/** Runs one provider hook the way its agent does: JSON in, one decision out. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export const HOOKS = {
  claude: "apps/bridge/src/bin/claude-hook.ts",
  codex: "apps/bridge/src/bin/codex-hook.ts",
  codexPolicy: "apps/bridge/src/bin/codex-policy-hook.ts",
  cursor: "apps/bridge/src/bin/cursor-hook.ts",
  cursorMcp: "apps/bridge/src/bin/cursor-mcp-hook.ts",
} as const;

export function runHook(
  agent: keyof typeof HOOKS,
  configDir: string,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Record<string, unknown> {
  const child = spawnSync(process.execPath, ["--import", "tsx", HOOKS[agent]], {
    cwd: process.cwd(),
    env: { ...process.env, GRANTTAP_CONFIG_DIR: configDir, ...extraEnv },
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.trim(), `${agent} hook returned no decision`);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}
