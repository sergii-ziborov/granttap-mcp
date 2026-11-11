import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { usableEngineBinary } from "../../apps/bridge/src/engine/protocol/engine-declaration";

const root = join(import.meta.dirname, "../..");
const launcher = join(root, "bin/granttap-mcp.mjs");
// Every Engine download answers 404, as for the withdrawn x64 releases; nothing reaches the network.
const unavailableDownloads = "--import=data:text/javascript,globalThis.fetch=async()=>new%20Response(null,{status:404});";

test("setup completes the helper, hooks and summary when no Engine can be prepared", t => {
  // The managed installation refuses linked ancestors, and macOS links /var to /private/var.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "granttap-setup-no-engine-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ["home", "config", "cursor", "claude", "codex", "agents"]) mkdirSync(join(directory, path));
  const env = { ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, unavailableDownloads].filter(Boolean).join(" "),
    HOME: join(directory, "home"), GRANTTAP_CONFIG_DIR: join(directory, "config"),
    NODVOX_CONFIG_DIR: join(directory, "legacy-config"), GRANTTAP_CURSOR_DIR: join(directory, "cursor"),
    GRANTTAP_CURSOR_MCP_CONFIG: join(directory, "cursor", "mcp.json"), GRANTTAP_CLAUDE_DIR: join(directory, "claude"),
    GRANTTAP_CODEX_DIR: join(directory, "codex"), GRANTTAP_CODEX_BIN: join(directory, "missing-codex"),
    GRANTTAP_LAUNCH_AGENTS_DIR: join(directory, "agents"), GRANTTAP_PINNED_MONITOR_BIN: join(directory, "missing-monitor"),
    GRANTTAP_PINNED_MONITOR_ROOT: join(directory, "missing-root"), GRANTTAP_MONITOR_CWD: join(directory, "workspace"),
    GRANTTAP_NODE: process.execPath, GRANTTAP_SKIP_LAUNCHCTL: "1", GRANTTAP_SKIP_PAIRING: "1" };
  const setup = (...args: string[]) => spawnSync(process.execPath, [launcher, "setup", ...args],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });

  const invalid = setup("--engine", "relative/granttap-engine");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /absolute path to an executable/);
  assert.equal(existsSync(join(directory, "cursor", "hooks.json")), false, "argument errors stop before any hook is written");

  const hostEngine = ["/usr/local/bin/granttap-engine", "/opt/homebrew/bin/granttap-engine"].some(usableEngineBinary);
  const first = setup();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`Background helper\\s+${process.platform === "darwin" ? "Ready" : "Needs attention"}`));
  assert.match(first.stdout, /Next: /);
  assert.ok(existsSync(join(directory, "cursor", "hooks.json")), "provider hooks are still installed");
  if (process.platform === "darwin") assert.ok(readdirSync(join(directory, "agents")).length > 0, "the helper is still installed");
  if (!hostEngine) {
    assert.match(first.stdout, /Project Governance\s+No engine found/);
    assert.match(first.stdout, /^Graph Engine unavailable on this computer: (?:Verified Engine download is unavailable|No verified Engine release is available for this computer yet)\. Graph and Project Governance stay off\.$/m);
  }

  // An Engine already installed in a standard location is used when the download fails.
  const local = join(directory, "home", ".local", "bin", "granttap-engine");
  mkdirSync(join(local, ".."), { recursive: true });
  writeFileSync(local, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const second = setup();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Project Governance\s+Ready/);
  assert.match(second.stdout, /^Engine not prepared: .+\. Using the verified Engine already installed on this computer\.$/m);
});
