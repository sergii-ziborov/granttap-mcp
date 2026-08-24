import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  pendingApprovalRequests,
  registerPendingApproval,
} from "../apps/bridge/src/approval-state";
import { resolveCursorMcpServer } from "../apps/bridge/src/cursor-mcp-policy";
import { protectedGrantTapAccess } from "../apps/bridge/src/self-protection";

const HOOKS = {
  claude: "apps/bridge/src/bin/claude-hook.ts",
  codex: "apps/bridge/src/bin/codex-hook.ts",
  codexPolicy: "apps/bridge/src/bin/codex-policy-hook.ts",
  cursor: "apps/bridge/src/bin/cursor-hook.ts",
  cursorMcp: "apps/bridge/src/bin/cursor-mcp-hook.ts",
} as const;

function runHook(
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

test("provider hooks deny direct access to GrantTap trust state before bypass or auto policy", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "granttap-self-protection-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const protectedPath = join(configDir, "machine.json");
  const cases: Array<[keyof typeof HOOKS, Record<string, unknown>]> = [
    ["claude", {
      session_id: "chat", tool_name: "Read", permission_mode: "bypassPermissions",
      tool_input: { file_path: protectedPath },
    }],
    ["codex", {
      session_id: "chat", tool_name: "shell_command",
      tool_input: { command: `cat ${protectedPath}` },
    }],
    ["codexPolicy", {
      session_id: "chat", tool_name: "Read", tool_input: { path: "~/.granttap/config.json" },
    }],
    ["cursor", { command: `cat ${protectedPath}` }],
    ["cursorMcp", {
      tool_name: "read_file", tool_input: { path: "$HOME/.granttap/session-keys.json" },
    }],
  ];
  for (const [provider, input] of cases) {
    const output = runHook(provider, configDir, input);
    assert.match(JSON.stringify(output), /protects its local pairing and policy files/);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(configDir.replaceAll("/", "\\/")));
  }
  assert.ok(protectedGrantTapAccess("Read", { path: "/tmp/.nodvox/key.json" }));
  assert.equal(protectedGrantTapAccess("Write", {
    file_path: "/repo/README.md", content: "Document ~/.granttap without reading it",
  }), null);
});

test("provider hooks enforce disabled capabilities only in the exact root chat", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "granttap-hook-capabilities-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    enabled: true,
    excludedSessions: [],
    sessionAccess: {},
    sessionMcpDisabled: { "chat-a": ["filesystem"] },
    sessionSkillsDisabled: { "chat-a": ["release-check"] },
    sessionShellDisabled: ["chat-a"],
  }));

  const cursorDb = join(configDir, "cursor-state.vscdb");
  execFileSync("sqlite3", [cursorDb, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);"]);
  const parent = JSON.stringify({
    composerId: "chat-a",
    name: "Root chat",
    subagentComposerIds: ["chat-a-child"],
  }).replaceAll("'", "''");
  const child = JSON.stringify({
    composerId: "chat-a-child",
    name: "Nested agent",
    subagentComposerIds: [],
  }).replaceAll("'", "''");
  execFileSync("sqlite3", [cursorDb,
    `INSERT INTO cursorDiskKV VALUES('composerData:chat-a','${parent}');`
      + ` INSERT INTO cursorDiskKV VALUES('composerData:chat-a-child','${child}');`,
  ]);
  const cursorDir = join(configDir, "cursor");
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(join(cursorDir, "mcp.json"), JSON.stringify({
    mcpServers: { filesystem: { command: "npx", args: ["-y", "@mcp/filesystem"] } },
  }));
  const cursorEnv = {
    GRANTTAP_CURSOR_STATE_DB: cursorDb,
    GRANTTAP_CURSOR_DIR: cursorDir,
  };

  const claudeMcp = runHook("claude", configDir, {
    session_id: "chat-a",
    tool_name: "mcp__filesystem__read_file",
    tool_input: { path: "README.md" },
  });
  assert.equal(
    (claudeMcp.hookSpecificOutput as Record<string, unknown>).permissionDecision,
    "deny",
  );

  const claudeSkill = runHook("claude", configDir, {
    session_id: "chat-a",
    tool_name: "Skill",
    tool_input: { skill: "release-check" },
  });
  assert.equal(
    (claudeSkill.hookSpecificOutput as Record<string, unknown>).permissionDecision,
    "deny",
  );

  const codexShell = runHook("codex", configDir, {
    session_id: "chat-a",
    tool_use_id: "call-shell-a",
    tool_name: "shell_command",
    tool_input: { command: "npm test" },
  });
  assert.match(JSON.stringify(codexShell), /disabled CLI\/shell/);

  const codexPolicy = runHook("codexPolicy", configDir, {
    hook_event_name: "PreToolUse",
    session_id: "chat-a",
    tool_name: "mcp__filesystem__read_file",
    tool_input: { path: "README.md" },
  });
  assert.equal(
    (codexPolicy.hookSpecificOutput as Record<string, unknown>).permissionDecision,
    "deny",
  );

  for (const conversationId of ["chat-a", "chat-a-child"]) {
    const shell = runHook("cursor", configDir, {
      conversation_id: conversationId,
      command: "npm test",
    }, cursorEnv);
    assert.equal(shell.permission, "deny");
  }
  const childMcp = runHook("cursorMcp", configDir, {
    conversation_id: "chat-a-child",
    mcp_server_name: "filesystem",
    tool_name: "read_file",
  }, cursorEnv);
  assert.equal(childMcp.permission, "deny");

  const otherChat = runHook("claude", configDir, {
    session_id: "chat-b",
    tool_name: "mcp__filesystem__read_file",
    tool_input: { path: "README.md" },
  });
  assert.equal(
    (otherChat.hookSpecificOutput as Record<string, unknown>).permissionDecision,
    "ask",
    "chat-a policy must not leak into chat-b",
  );

  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    enabled: false,
    excludedSessions: [],
    sessionAccess: {},
    sessionMcpDisabled: { "chat-a": ["filesystem"] },
    sessionSkillsDisabled: {},
    sessionShellDisabled: [],
  }));
  const pausedButBlocked = runHook("claude", configDir, {
    session_id: "chat-a",
    tool_name: "mcp__filesystem__read_file",
  });
  assert.equal(
    (pausedButBlocked.hookSpecificOutput as Record<string, unknown>).permissionDecision,
    "deny",
  );
});

test("Cursor MCP resolver abstains when a command identifies multiple servers", (t) => {
  const cursorDir = mkdtempSync(join(tmpdir(), "granttap-cursor-mcp-resolution-"));
  t.after(() => rmSync(cursorDir, { recursive: true, force: true }));
  writeFileSync(join(cursorDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@mcp/filesystem"] },
      duplicate: { command: "npx" },
      context7: { url: "https://mcp.example.test/context" },
    },
  }));
  assert.equal(resolveCursorMcpServer({ command: "filesystem" }, cursorDir), "filesystem");
  assert.equal(
    resolveCursorMcpServer({ url: "https://mcp.example.test/context" }, cursorDir),
    "context7",
  );
  assert.equal(resolveCursorMcpServer({ command: "npx" }, cursorDir), null);
});

test("Cursor afterShell correlates a child event to its root approval", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "granttap-cursor-after-root-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });

  registerPendingApproval({
    type: "approval.request",
    requestId: "cursor-root-request",
    agent: "cursor",
    kind: "permission",
    tool: "Shell",
    title: "npm test",
    command: "npm test",
    sessionId: "chat-root",
    risk: "medium",
    createdAt: Date.now(),
  });
  registerPendingApproval({
    type: "approval.request",
    requestId: "cursor-mcp-request",
    agent: "cursor",
    kind: "permission",
    tool: "mcp__filesystem__read_file",
    title: "filesystem/read_file",
    command: "filesystem/read_file",
    sessionId: "chat-root",
    risk: "medium",
    createdAt: Date.now(),
  });
  const cursorDb = join(configDir, "cursor-state.vscdb");
  execFileSync("sqlite3", [cursorDb, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);"]);
  const parent = JSON.stringify({
    composerId: "chat-root",
    subagentComposerIds: ["chat-child"],
  }).replaceAll("'", "''");
  execFileSync("sqlite3", [cursorDb,
    `INSERT INTO cursorDiskKV VALUES('composerData:chat-root','${parent}');`,
  ]);

  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "apps/bridge/src/bin/cursor-after-shell.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GRANTTAP_CONFIG_DIR: configDir,
        GRANTTAP_CURSOR_STATE_DB: cursorDb,
      },
      input: JSON.stringify({ conversation_id: "chat-child", command: "npm test" }),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {});
  assert.deepEqual(
    pendingApprovalRequests().map((request) => request.requestId),
    ["cursor-mcp-request"],
    "afterShell must not cancel a concurrent MCP approval in the same chat",
  );
});
