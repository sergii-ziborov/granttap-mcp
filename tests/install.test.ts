import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hookCommand,
  inspectAgentIntegrations,
  inspectCursorIntegration,
  installClaudeHook,
  installCodexHook,
  installCursorHook,
  installMonitorHelper,
} from "../apps/bridge/src/install";

test("macOS background task sync is installed as a terminal-free LaunchAgent", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = await mkdtemp(join(tmpdir(), "granttap-launch-agent-"));
  const agentsDir = join(root, "LaunchAgents");
  const configDir = join(root, "config");
  const previous = {
    agents: process.env.GRANTTAP_LAUNCH_AGENTS_DIR,
    config: process.env.GRANTTAP_CONFIG_DIR,
    cwd: process.env.GRANTTAP_MONITOR_CWD,
    pinnedBin: process.env.GRANTTAP_PINNED_MONITOR_BIN,
    pinnedRoot: process.env.GRANTTAP_PINNED_MONITOR_ROOT,
    skip: process.env.GRANTTAP_SKIP_LAUNCHCTL,
  };
  process.env.GRANTTAP_LAUNCH_AGENTS_DIR = agentsDir;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  process.env.GRANTTAP_MONITOR_CWD = `/tmp/granttap-default-workspace&<>'"`;
  // Exercise the portable package fallback independently of this developer
  // machine's intentional, existing nodvox monitor pin.
  process.env.GRANTTAP_PINNED_MONITOR_BIN = join(root, "missing-nodvox-monitor");
  process.env.GRANTTAP_PINNED_MONITOR_ROOT = join(root, "missing-nodvox-root");
  process.env.GRANTTAP_SKIP_LAUNCHCTL = "1";
  t.after(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    };
    restore("GRANTTAP_LAUNCH_AGENTS_DIR", previous.agents);
    restore("GRANTTAP_CONFIG_DIR", previous.config);
    restore("GRANTTAP_MONITOR_CWD", previous.cwd);
    restore("GRANTTAP_PINNED_MONITOR_BIN", previous.pinnedBin);
    restore("GRANTTAP_PINNED_MONITOR_ROOT", previous.pinnedRoot);
    restore("GRANTTAP_SKIP_LAUNCHCTL", previous.skip);
  });

  const first = installMonitorHelper();
  assert.equal(first.status, "installed");
  const path = join(agentsDir, "com.granttap.monitor.plist");
  const plist = await readFile(path, "utf8");
  assert.match(plist, /<string>monitor<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(
    plist,
    /<string>\/tmp\/granttap-default-workspace&amp;&lt;&gt;&apos;&quot;<\/string>/,
  );
  assert.match(plist, /monitor\.log/);

  const second = installMonitorHelper();
  assert.equal(second.status, "already");
});

test("installMonitorHelper preserves an existing nodvox-pinned LaunchAgent", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = await mkdtemp(join(tmpdir(), "granttap-launch-preserve-"));
  const agentsDir = join(root, "LaunchAgents");
  await mkdir(agentsDir, { recursive: true });
  const path = join(agentsDir, "com.granttap.monitor.plist");
  const pinned = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<plist><dict>",
    "<key>Label</key><string>com.granttap.monitor</string>",
    "<string>/Users/serhiirihgt/dev/nodvox/bin/granttap.mjs</string>",
    "<string>monitor</string>",
    "</dict></plist>",
    "",
  ].join("\n");
  await writeFile(path, pinned);
  const previous = {
    agents: process.env.GRANTTAP_LAUNCH_AGENTS_DIR,
    skip: process.env.GRANTTAP_SKIP_LAUNCHCTL,
  };
  process.env.GRANTTAP_LAUNCH_AGENTS_DIR = agentsDir;
  process.env.GRANTTAP_SKIP_LAUNCHCTL = "1";
  t.after(() => {
    if (previous.agents == null) delete process.env.GRANTTAP_LAUNCH_AGENTS_DIR;
    else process.env.GRANTTAP_LAUNCH_AGENTS_DIR = previous.agents;
    if (previous.skip == null) delete process.env.GRANTTAP_SKIP_LAUNCHCTL;
    else process.env.GRANTTAP_SKIP_LAUNCHCTL = previous.skip;
  });

  const result = installMonitorHelper();
  assert.equal(result.status, "already");
  assert.match(result.detail, /preserved nodvox pin/);
  assert.equal(await readFile(path, "utf8"), pinned);
});

test("setup replaces stale GrantTap and Nodvox hook paths for every provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-hook-upgrade-"));
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  const cursorDir = join(root, "cursor");
  await Promise.all([
    mkdir(claudeDir, { recursive: true }),
    mkdir(codexDir, { recursive: true }),
    mkdir(cursorDir, { recursive: true }),
  ]);
  await writeFile(join(claudeDir, "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command",
      command: "node /tmp/old-granttap/bin/granttap-mcp.mjs hook claude" }] }] },
  }));
  await writeFile(join(codexDir, "config.toml"), [
    "[mcp_servers.granttap]", 'command = "node"',
    "[[hooks.PermissionRequest]]", 'matcher = ".*"',
    "[[hooks.PermissionRequest.hooks]]", 'type = "command"',
    "command = 'node \"/tmp/nodvox/bin/nodvox.mjs\" hook codex'", "timeout = 120", "",
  ].join("\n"));
  await writeFile(join(cursorDir, "hooks.json"), JSON.stringify({
    version: 1,
    hooks: {
      beforeShellExecution: [{
        command: "node /tmp/old-granttap/bin/granttap-mcp.mjs hook cursor",
      }],
      afterShellExecution: [{
        command: "node /tmp/old-granttap/bin/granttap-mcp.mjs hook cursor-after",
      }],
      beforeMCPExecution: [{
        command: "node /tmp/old-granttap/bin/granttap-mcp.mjs hook cursor-mcp",
        failClosed: true,
      }],
    },
  }));
  const previousClaude = process.env.GRANTTAP_CLAUDE_DIR;
  const previousCodex = process.env.GRANTTAP_CODEX_DIR;
  const previousCursor = process.env.GRANTTAP_CURSOR_DIR;
  process.env.GRANTTAP_CLAUDE_DIR = claudeDir;
  process.env.GRANTTAP_CODEX_DIR = codexDir;
  process.env.GRANTTAP_CURSOR_DIR = cursorDir;
  t.after(() => {
    if (previousClaude == null) delete process.env.GRANTTAP_CLAUDE_DIR;
    else process.env.GRANTTAP_CLAUDE_DIR = previousClaude;
    if (previousCodex == null) delete process.env.GRANTTAP_CODEX_DIR;
    else process.env.GRANTTAP_CODEX_DIR = previousCodex;
    if (previousCursor == null) delete process.env.GRANTTAP_CURSOR_DIR;
    else process.env.GRANTTAP_CURSOR_DIR = previousCursor;
  });

  assert.equal(installCursorHook().status, "installed");
  assert.equal(installClaudeHook().status, "installed");
  assert.equal(installCodexHook().status, "installed");
  assert.match(await readFile(join(claudeDir, "settings.json"), "utf8"), /granttap-mcp\/bin\/granttap-mcp\.mjs/);
  const codex = await readFile(join(codexDir, "config.toml"), "utf8");
  assert.match(codex, /granttap-mcp\/bin\/granttap-mcp\.mjs/);
  assert.doesNotMatch(codex, /nodvox\.mjs/);
  assert.match(codex, /\[\[hooks\.PreToolUse\]\]/);
  const cursor = JSON.parse(await readFile(join(cursorDir, "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ command: string; failClosed?: boolean }>>;
  };
  assert.equal(cursor.hooks.beforeShellExecution?.[0]?.command, hookCommand("cursor"));
  assert.equal(cursor.hooks.afterShellExecution?.[0]?.command, hookCommand("cursor-after"));
  assert.equal(cursor.hooks.beforeMCPExecution?.[0]?.command, hookCommand("cursor-mcp"));
  for (const entries of Object.values(cursor.hooks)) {
    assert.equal(entries[0]?.failClosed, false);
  }
  assert.deepEqual(inspectCursorIntegration(), { installed: true, hookConfigured: true });
  assert.equal(installCursorHook().status, "already");
});

test("agent integration inspection is read-only and reports binaries and hooks separately", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-agent-status-"));
  const binDir = join(root, "bin");
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  const cursorDir = join(root, "cursor");
  await Promise.all([
    mkdir(binDir, { recursive: true }),
    mkdir(claudeDir, { recursive: true }),
    mkdir(codexDir, { recursive: true }),
    mkdir(cursorDir, { recursive: true }),
  ]);
  const fakeClaude = join(binDir, "claude");
  const fakeCodex = join(binDir, "codex");
  await Promise.all([
    writeFile(fakeClaude, "#!/bin/sh\n", { mode: 0o755 }),
    writeFile(fakeCodex, "#!/bin/sh\n", { mode: 0o755 }),
    writeFile(join(claudeDir, "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{
        matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*|Skill|skill__.*",
        hooks: [{ type: "command", command: hookCommand("claude") }],
      }] },
    })),
    writeFile(join(codexDir, "config.toml"), [
      "[features]", "hooks = true",
      "[[hooks.PermissionRequest]]", 'matcher = ".*"',
      "[[hooks.PermissionRequest.hooks]]", 'type = "command"',
      `command = '${hookCommand("codex")}'`,
      "timeout = 120",
      "[[hooks.PreToolUse]]", 'matcher = ".*"',
      "[[hooks.PreToolUse.hooks]]", 'type = "command"',
      `command = '${hookCommand("codex-policy")}'`,
      "timeout = 30",
      "",
    ].join("\n")),
  ]);

  const previous = {
    path: process.env.PATH,
    claudeDir: process.env.GRANTTAP_CLAUDE_DIR,
    codexDir: process.env.GRANTTAP_CODEX_DIR,
    cursorDir: process.env.GRANTTAP_CURSOR_DIR,
  };
  process.env.PATH = binDir;
  process.env.GRANTTAP_CLAUDE_DIR = claudeDir;
  process.env.GRANTTAP_CODEX_DIR = codexDir;
  process.env.GRANTTAP_CURSOR_DIR = cursorDir;
  t.after(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    };
    restore("PATH", previous.path);
    restore("GRANTTAP_CLAUDE_DIR", previous.claudeDir);
    restore("GRANTTAP_CODEX_DIR", previous.codexDir);
    restore("GRANTTAP_CURSOR_DIR", previous.cursorDir);
  });

  assert.deepEqual(inspectAgentIntegrations(), [
    { agent: "codex", installed: true, hookConfigured: true },
    { agent: "claude", installed: true, hookConfigured: true },
    { agent: "cursor", installed: false, hookConfigured: false },
    { agent: "grok", installed: false, hookConfigured: false },
  ]);

  await Promise.all([
    writeFile(join(claudeDir, "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{
        matcher: "Bash|mcp__.*|Skill|skill__.*",
        hooks: [{ command: hookCommand("claude") }],
      }] },
    })),
    writeFile(join(codexDir, "config.toml"), [
      "[[hooks.PermissionRequest]]", 'matcher = ".*"',
      `command = '${hookCommand("codex")}'`,
      "[[hooks.PreToolUse]]", 'matcher = ".*"',
      `command = '${hookCommand("codex-policy")}'`,
      "",
    ].join("\n")),
  ]);
  assert.deepEqual(inspectAgentIntegrations(), [
    { agent: "codex", installed: true, hookConfigured: false },
    { agent: "claude", installed: true, hookConfigured: false },
    { agent: "cursor", installed: false, hookConfigured: false },
    { agent: "grok", installed: false, hookConfigured: false },
  ], "partial matchers and flat TOML commands are not complete hook installations");
});
