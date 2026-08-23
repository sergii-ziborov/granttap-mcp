import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPairing } from "../apps/bridge/src/config";

const entries = {
  claude: "apps/bridge/src/bin/claude-hook.ts",
  codex: "apps/bridge/src/bin/codex-hook.ts",
  codexPolicy: "apps/bridge/src/bin/codex-policy-hook.ts",
  cursor: "apps/bridge/src/bin/cursor-hook.ts",
  cursorMcp: "apps/bridge/src/bin/cursor-mcp-hook.ts",
} as const;

function run(
  entry: keyof typeof entries,
  configDir: string,
  input: string | Record<string, unknown>,
): { stdout: string; value?: any } {
  const child = spawnSync(process.execPath, ["--import", "tsx", entries[entry]], {
    cwd: process.cwd(), env: { ...process.env, GRANTTAP_CONFIG_DIR: configDir },
    input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const stdout = child.stdout.trim();
  return { stdout, value: stdout ? JSON.parse(stdout) : undefined };
}

function runtime(root: string, value: Record<string, unknown>): void {
  writeFileSync(join(root, "config.json"), JSON.stringify({
    enabled: true, excludedSessions: [], autoAcceptDefault: "ask", autoAcceptBySession: {},
    autoAcceptPaused: false, sessionAccess: {}, sessionMcpDisabled: {},
    sessionSkillsDisabled: {}, sessionShellDisabled: [],
    providerSettings: { claude: true, codex: true, cursor: true, grok: true }, meshEnabled: true,
    ...value,
  }));
}

test("hook entry points fail safely when disabled, unscoped, unpaired, or malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-hook-fallbacks-"));
  runtime(root, {});
  assert.match(run("claude", root, "bad-json").stdout, /invalid hook JSON/);
  assert.match(run("codex", root, "bad-json").stdout, /invalid hook JSON/);
  assert.match(run("cursor", root, "bad-json").stdout, /could not read this shell call/);
  assert.match(run("cursorMcp", root, "bad-json").stdout, /could not correlate this MCP call/);
  assert.equal(run("codexPolicy", root, "bad-json").stdout, "");

  runtime(root, { providerSettings: { claude: false, codex: false, cursor: false, grok: true } });
  assert.equal(run("claude", root, { session_id: "s", tool_name: "Read" }).stdout, "");
  assert.equal(run("codex", root, { session_id: "s", tool_name: "Read" }).stdout, "");
  assert.equal(run("codexPolicy", root, { session_id: "s", tool_name: "Read" }).stdout, "");
  assert.match(run("cursor", root, { conversation_id: "s", command: "pwd" }).stdout, /disabled/);
  assert.match(run("cursorMcp", root, {
    conversation_id: "s", mcp_server_name: "github", tool_name: "read",
  }).stdout, /disabled/);

  runtime(root, {});
  assert.match(run("cursor", root, { command: "pwd" }).stdout, /unscoped/);
  assert.match(run("cursorMcp", root, { mcp_server_name: "github", tool_name: "read" }).stdout, /unscoped/);
  assert.match(run("claude", root, { session_id: "s", tool_name: "Read" }).stdout, /not paired/);
  assert.match(run("codex", root, { session_id: "s", tool_name: "Read" }).stdout, /not paired/);
  assert.match(run("cursor", root, { conversation_id: "s", command: "git push" }).stdout, /not paired/);
  assert.match(run("cursorMcp", root, {
    conversation_id: "s", mcp_server_name: "github", tool_name: "read",
  }).stdout, /not paired/);
});

test("paired hooks apply local full-auto decisions without contacting a phone", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-hook-auto-"));
  runtime(root, { autoAcceptDefault: "full" });
  writeFileSync(join(root, "machine.json"), JSON.stringify(createPairing("ws://127.0.0.1:1").machineCfg));
  const claude = run("claude", root, {
    session_id: "s", tool_name: "Write", tool_input: { file_path: "/repo/a.ts" },
  }).value;
  assert.equal(claude.hookSpecificOutput.permissionDecision, "allow");
  const codex = run("codex", root, {
    session_id: "s", tool_use_id: "call", tool_name: "shell_command", tool_input: { command: "echo hi" },
  }).value;
  assert.equal(codex.hookSpecificOutput.decision.behavior, "allow");
  assert.equal(run("cursor", root, { conversation_id: "s", command: "echo hi" }).value.permission, "allow");
  const mcp = run("cursorMcp", root, {
    conversation_id: "s", mcp_server_name: "github", tool_name: "read",
    workspace_roots: ["/repo"],
  }).value;
  assert.equal(mcp.permission, "allow");
});
