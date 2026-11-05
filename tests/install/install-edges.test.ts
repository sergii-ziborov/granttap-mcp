import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { versionRoot } from "../../apps/bridge/src/runtime-updates/selection.mjs";
import { projectCodexHooks } from "../../apps/bridge/src/codex-hook-trust";
import { hookNodeCommand } from "../../apps/bridge/src/install/stable-node";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hookCommand,
  inspectAgentIntegrations,
  inspectCursorIntegration,
  inspectMonitorHelper,
  installClaudeHook,
  installCodexHook,
  installCursorHook,
  installMonitorHelper,
  pinnedMonitorBin,
  pinnedMonitorRoot,
} from "../../apps/bridge/src/install";

function environment(t: test.TestContext, values: Record<string, string>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("installers reject invalid provider configuration without overwriting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-invalid-install-"));
  const claude = join(root, "claude");
  const cursor = join(root, "cursor");
  await Promise.all([mkdir(claude), mkdir(cursor)]);
  await writeFile(join(claude, "settings.json"), "{broken");
  await writeFile(join(cursor, "hooks.json"), "{broken");
  environment(t, { GRANTTAP_CLAUDE_DIR: claude, GRANTTAP_CURSOR_DIR: cursor });

  assert.equal(installClaudeHook().status, "manual");
  assert.equal(installCursorHook().status, "manual");
  assert.deepEqual(inspectCursorIntegration(), { installed: true, hookConfigured: false });
  assert.equal(
    inspectAgentIntegrations().find((item) => item.agent === "claude")?.hookConfigured,
    false,
  );

  await writeFile(join(cursor, "hooks.json"), JSON.stringify({ version: 2, hooks: {} }));
  assert.equal(installCursorHook().status, "manual");
});

test("fresh and legacy hooks are installed, repaired, and then idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-install-edges-"));
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  const cursor = join(root, "cursor");
  environment(t, {
    GRANTTAP_CLAUDE_DIR: claude,
    GRANTTAP_CODEX_DIR: codex,
    GRANTTAP_CURSOR_DIR: cursor,
  });

  assert.equal(installClaudeHook().status, "installed");
  assert.equal(installClaudeHook().status, "already");
  assert.equal(installCodexHook().status, "installed");
  assert.equal(installCodexHook().status, "already");
  assert.equal(installCursorHook().status, "installed");
  assert.equal(installCursorHook().status, "already");

  await writeFile(join(claude, "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ command: "npx -y nodvox" }] }] },
  }));
  assert.equal(installClaudeHook().status, "installed");
  assert.match(await readFile(join(claude, "settings.json"), "utf8"), /hook claude/);

  await writeFile(join(codex, "config.toml"), [
    "[features]", "hooks = false # disabled", "[mcp_servers.other]", "command = 'other'", "",
  ].join("\n"));
  assert.equal(installCodexHook().status, "installed");
  assert.match(await readFile(join(codex, "config.toml"), "utf8"), /hooks = true/);

  const cursorDocument = JSON.parse(await readFile(join(cursor, "hooks.json"), "utf8"));
  cursorDocument.hooks.beforeShellExecution[0].timeout = 1;
  cursorDocument.hooks.beforeShellExecution[0].failClosed = true;
  await writeFile(join(cursor, "hooks.json"), JSON.stringify(cursorDocument));
  assert.equal(installCursorHook().status, "installed");
});

test("hooks an earlier runtime wrote through the version cache survive an update and setup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cached-launcher-"));
  const config = join(root, "config"), claude = join(root, "claude"), codex = join(root, "codex"), cursor = join(root, "cursor");
  environment(t, { GRANTTAP_CONFIG_DIR: config, GRANTTAP_CLAUDE_DIR: claude, GRANTTAP_CODEX_DIR: codex,
    GRANTTAP_CURSOR_DIR: cursor });
  const launcher = async (version: string) => {
    const dir = versionRoot(join(config, "runtime-updates"), version);
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "granttap-mcp.mjs"), "");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "granttap-mcp", version }));
    return `node "${join(dir, "bin", "granttap-mcp.mjs")}" internal hook`;
  };
  const current = hookCommand("claude").replace(/ claude$/, ""), earlier = await launcher("0.0.1");
  const files = [join(claude, "settings.json"), join(codex, "config.toml"), join(cursor, "hooks.json")];
  const point = async (from: string, to: string) => {
    for (const path of files) {
      const [a, b] = path.endsWith(".toml")
        ? [from, to].map(text => text.replace(/^node /, hookNodeCommand("codex") + " "))
        : [from, to].map((text) => JSON.stringify(text).slice(1, -1));
      await writeFile(path, (await readFile(path, "utf8")).replaceAll(a!, b!));
    }
  };
  installClaudeHook(); installCodexHook(); installCursorHook();
  await point(current, earlier);
  const before = await Promise.all(files.map((path) => readFile(path, "utf8")));
  assert.deepEqual([installClaudeHook().status, installCodexHook().status, installCursorHook().status],
    ["already", "already", "already"], "Rewriting the path would also void Codex's per-command trust.");
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before);
  const status = inspectAgentIntegrations();
  assert.equal(status.find((item) => item.agent === "claude")?.hookConfigured, true);
  assert.equal(status.find((item) => item.agent === "codex")?.hookConfigured, true);
  assert.equal(inspectCursorIntegration().hookConfigured, true);
  const [policy] = projectCodexHooks({ data: [{ hooks: [{ key: "k", eventName: "preToolUse", command: `${earlier.replace(/^node /, hookNodeCommand("codex") + " ")} codex-policy`,
    handlerType: "command", source: "user", matcher: ".*", timeoutSec: 30, enabled: true, isManaged: false,
    currentHash: "a".repeat(64), trustStatus: "trusted" }], errors: [] }] });
  assert.equal(policy?.trustStatus, "trusted");

  await point(earlier, await launcher("999.0.0"));
  assert.equal(installClaudeHook().status, "installed", "A newer, rolled-back release is not left in charge.");
  const settings = JSON.parse(await readFile(files[0]!, "utf8"));
  assert.equal(settings.hooks.PreToolUse.flatMap((entry: { hooks: unknown[] }) => entry.hooks)
    .find((hook: { command: string }) => hook.command.endsWith(" claude"))?.command, hookCommand("claude"));
});

test("agent inspection handles absolute executables and incomplete hook shapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-agent-inspect-"));
  const binary = join(root, "claude");
  const claude = join(root, "claude-config");
  const cursor = join(root, "cursor-config");
  await Promise.all([mkdir(claude), mkdir(cursor), writeFile(binary, "#!/bin/sh\n")]);
  await chmod(binary, 0o755);
  await writeFile(join(claude, "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "other", command: hookCommand("claude") }] }] },
  }));
  await writeFile(join(cursor, "hooks.json"), JSON.stringify({ version: 1, hooks: {
    beforeShellExecution: [{ command: hookCommand("cursor"), timeout: 120, failClosed: false }],
  } }));
  environment(t, {
    GRANTTAP_CLAUDE_BIN: binary,
    GRANTTAP_CLAUDE_DIR: claude,
    GRANTTAP_CURSOR_DIR: cursor,
  });
  const status = inspectAgentIntegrations();
  assert.equal(status.find((item) => item.agent === "claude")?.installed, true);
  assert.equal(status.find((item) => item.agent === "claude")?.hookConfigured, false);
  assert.deepEqual(inspectCursorIntegration(), { installed: true, hookConfigured: false });
});

test("monitor status validates the pinned and portable plist contracts", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = await mkdtemp(join(tmpdir(), "granttap-monitor-inspect-"));
  const agents = join(root, "agents");
  const pinned = join(root, "granttap.mjs");
  await mkdir(agents);
  await writeFile(pinned, "#!/usr/bin/env node\n");
  await chmod(pinned, 0o755);
  environment(t, {
    GRANTTAP_LAUNCH_AGENTS_DIR: agents,
    GRANTTAP_PINNED_MONITOR_BIN: pinned,
    GRANTTAP_PINNED_MONITOR_ROOT: root,
    GRANTTAP_SKIP_LAUNCHCTL: "1",
  });
  assert.equal(pinnedMonitorBin(), pinned);
  assert.equal(pinnedMonitorRoot(), root);
  assert.deepEqual(inspectMonitorHelper(), { configured: false, running: false });
  assert.equal(installMonitorHelper().status, "installed");
  assert.equal(installMonitorHelper().status, "already");
  assert.equal(inspectMonitorHelper().configured, true);
});
