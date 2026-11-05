import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hookCommand } from "../../inspect";
import { hookNodeCommand } from "..";
import { installCodexHook } from "../../hooks";

test("Codex's installed hook runs when a Dock-launched app has no Node on PATH", {
  skip: process.platform === "win32",
}, t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-dock-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("/bin/sh", ["-c", hookCommand("codex-policy")], {
    env: { ...process.env, PATH: "/usr/bin:/bin", GRANTTAP_CONFIG_DIR: root,
      GRANTTAP_SKIP_LAUNCHCTL: "1", GRANTTAP_ENGINE_ENABLED: "0", GRANTTAP_PROJECT_POLICY_ENABLED: "0" },
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "codex-dock-chat",
      tool_use_id: "call-dock-notify", tool_name: "mcp__granttap__notify",
      tool_input: { message: "Dock environment check", operationId: "dock-check" } }),
    encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const calls = JSON.parse(readFileSync(join(root, "mesh-tool-calls.json"), "utf8")).calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "codex");
  assert.equal(calls[0].sessionId, "codex-dock-chat");
});

test("setup repairs legacy Codex Node commands and preserves unrelated configuration", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-codex-command-repair-"));
  const key = "GRANTTAP_CODEX_DIR", before = process.env[key];
  process.env[key] = root;
  t.after(() => {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(installCodexHook().status, "installed");
  const file = join(root, "config.toml");
  const legacy = readFileSync(file, "utf8").replaceAll(hookNodeCommand("codex"), "node");
  writeFileSync(file, legacy + "\n[projects.unrelated]\ntrust_level = 'untrusted'\n");
  assert.equal(installCodexHook().status, "installed");
  const repaired = readFileSync(file, "utf8");
  assert.ok(repaired.includes(hookCommand("codex")));
  assert.ok(repaired.includes(hookCommand("codex-policy")));
  assert.ok(repaired.includes("[projects.unrelated]\ntrust_level = 'untrusted'"));
  assert.equal(installCodexHook().status, "already");
});

test("an absolute Codex executable keeps spaces and shell characters literal", {
  skip: process.platform === "win32",
}, t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-node-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const node = join(root, 'node "$UNSET_TAG"');
  symlinkSync(process.execPath, node);
  const result = spawnSync("/bin/sh", ["-c", hookNodeCommand("codex", node) + " --version"], {
    env: { PATH: "/usr/bin:/bin", UNSET_TAG: "must-not-expand" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.version);
  assert.equal(hookNodeCommand("claude"), "node", "other provider definitions retain their command");
  assert.equal(hookNodeCommand("codex", "C:\\Program Files\\node.exe", "win32"), '"C:\\Program Files\\node.exe"');
});
