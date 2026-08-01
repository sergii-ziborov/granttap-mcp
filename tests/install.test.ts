import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installClaudeHook, installCodexHook, installMonitorHelper } from "../apps/bridge/src/install";

test("macOS background task sync is installed as a terminal-free LaunchAgent", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = await mkdtemp(join(tmpdir(), "granttap-launch-agent-"));
  const agentsDir = join(root, "LaunchAgents");
  const configDir = join(root, "config");
  const previous = {
    agents: process.env.GRANTTAP_LAUNCH_AGENTS_DIR,
    config: process.env.GRANTTAP_CONFIG_DIR,
    cwd: process.env.GRANTTAP_MONITOR_CWD,
    skip: process.env.GRANTTAP_SKIP_LAUNCHCTL,
  };
  process.env.GRANTTAP_LAUNCH_AGENTS_DIR = agentsDir;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  process.env.GRANTTAP_MONITOR_CWD = "/tmp/granttap-default-workspace";
  process.env.GRANTTAP_SKIP_LAUNCHCTL = "1";
  t.after(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    };
    restore("GRANTTAP_LAUNCH_AGENTS_DIR", previous.agents);
    restore("GRANTTAP_CONFIG_DIR", previous.config);
    restore("GRANTTAP_MONITOR_CWD", previous.cwd);
    restore("GRANTTAP_SKIP_LAUNCHCTL", previous.skip);
  });

  const first = installMonitorHelper();
  assert.equal(first.status, "installed");
  const path = join(agentsDir, "com.granttap.monitor.plist");
  const plist = await readFile(path, "utf8");
  assert.match(plist, /<string>monitor<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/tmp\/granttap-default-workspace<\/string>/);
  assert.match(plist, /monitor\.log/);

  const second = installMonitorHelper();
  assert.equal(second.status, "already");
});

test("setup replaces stale GrantTap and Nodvox hook paths for both agents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-hook-upgrade-"));
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  await Promise.all([
    mkdir(claudeDir, { recursive: true }), mkdir(codexDir, { recursive: true }),
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
  const previousClaude = process.env.GRANTTAP_CLAUDE_DIR;
  const previousCodex = process.env.GRANTTAP_CODEX_DIR;
  process.env.GRANTTAP_CLAUDE_DIR = claudeDir;
  process.env.GRANTTAP_CODEX_DIR = codexDir;
  t.after(() => {
    if (previousClaude == null) delete process.env.GRANTTAP_CLAUDE_DIR;
    else process.env.GRANTTAP_CLAUDE_DIR = previousClaude;
    if (previousCodex == null) delete process.env.GRANTTAP_CODEX_DIR;
    else process.env.GRANTTAP_CODEX_DIR = previousCodex;
  });

  assert.equal(installClaudeHook().status, "installed");
  assert.equal(installCodexHook().status, "installed");
  assert.match(await readFile(join(claudeDir, "settings.json"), "utf8"), /granttap-mcp\/bin\/granttap-mcp\.mjs/);
  const codex = await readFile(join(codexDir, "config.toml"), "utf8");
  assert.match(codex, /granttap-mcp\/bin\/granttap-mcp\.mjs/);
  assert.doesNotMatch(codex, /nodvox\.mjs/);
});
