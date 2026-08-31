import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPairing } from "../apps/bridge/src/config";

const entries = {
  claude: "apps/bridge/src/bin/claude-hook.ts",
  codex: "apps/bridge/src/bin/codex-hook.ts",
  codexPolicy: "apps/bridge/src/bin/codex-policy-hook.ts",
  cursor: "apps/bridge/src/bin/cursor-hook.ts",
  cursorMcp: "apps/bridge/src/bin/cursor-mcp-hook.ts",
} as const;

export async function startProjectPolicyEngine(root: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["tests/fixtures/fake-project-policy-engine.mjs", join(root, "engine.sock")],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake engine startup timed out")), 2_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fake engine exited ${code}`)));
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return child;
}

export async function stopProjectPolicyEngine(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

export function runProjectHook(
  entry: keyof typeof entries,
  root: string,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): { stdout: string; value?: any } {
  const child = spawnSync(process.execPath, ["--import", "tsx", entries[entry]], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GRANTTAP_CONFIG_DIR: root,
      GRANTTAP_ENGINE_ENABLED: "1",
      GRANTTAP_PROJECT_POLICY_ENABLED: "1",
      GRANTTAP_APPROVAL_TIMEOUT_MS: "1",
      ...extraEnv,
    },
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const stdout = child.stdout.trim();
  return { stdout, value: stdout ? JSON.parse(stdout) : undefined };
}

export async function writeProjectHookRuntime(root: string): Promise<void> {
  await writeFile(join(root, "config.json"), JSON.stringify({
    enabled: true,
    excludedSessions: [],
    autoAcceptDefault: "full",
    autoAcceptBySession: {},
    autoAcceptPaused: false,
    sessionAccess: {},
    sessionMcpDisabled: {},
    sessionSkillsDisabled: {},
    sessionShellDisabled: [],
    providerSettings: { claude: true, codex: true, cursor: true, grok: true },
    meshEnabled: true,
  }));
  const pairing = createPairing("ws://127.0.0.1:1");
  await writeFile(join(root, "machine.json"), JSON.stringify(pairing.machineCfg));
}
