import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Claude Project DENY and ASK precede bypass and auto-accept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claude-project-policy-"));
  const socket = join(root, "engine.sock");
  const engine = await startEngine(socket);
  t.after(async () => {
    if (engine.exitCode == null && engine.signalCode == null) {
      const exited = once(engine, "exit");
      engine.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
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

  const deny = runClaude(root, {
    session_id: "session", cwd: "/work/project", tool_name: "Write",
    tool_input: { file_path: "/work/project/a.ts" }, permission_mode: "bypassPermissions",
  });
  assert.equal(deny.value?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(deny.stdout, /Project test policy requires deny/);

  const ask = runClaude(root, {
    session_id: "session", cwd: "/work/project", tool_name: "Bash",
    tool_input: { command: "echo safe" }, permission_mode: "bypassPermissions",
  });
  assert.equal(ask.value?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(ask.stdout, /requires GrantTap approval/);

  const allow = runClaude(root, {
    session_id: "session", cwd: "/work/project", tool_name: "Read",
    tool_input: { file_path: "/work/project/a.ts" }, permission_mode: "bypassPermissions",
  });
  assert.equal(allow.stdout, "");
});

function runClaude(root: string, input: Record<string, unknown>): {
  stdout: string;
  value?: any;
} {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "apps/bridge/src/bin/claude-hook.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GRANTTAP_CONFIG_DIR: root,
        GRANTTAP_ENGINE_ENABLED: "1",
        GRANTTAP_PROJECT_POLICY_ENABLED: "1",
      },
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const stdout = child.stdout.trim();
  return { stdout, value: stdout ? JSON.parse(stdout) : undefined };
}

async function startEngine(socket: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["tests/fixtures/fake-project-policy-engine.mjs", socket],
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
