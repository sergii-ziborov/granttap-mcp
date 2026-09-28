import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHookRpc, readCodexHooks, trustCodexHook, ownedHookCommands } from "../index";

test("real Codex persists exact hook trust in an isolated home and invalidates changed definitions", {
  skip: !process.env.GRANTTAP_CODEX_TEST_BIN,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "granttap-hook-review-"));
  const commands = ownedHookCommands();
  const path = join(home, "config.toml");
  const config = `model = "gpt-6-sol"\n[hooks.state.unrelated]\nenabled = false\n` +
    `[[hooks.PreToolUse]]\nmatcher = ".*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = '${commands.policy}'\ntimeout = 30\n` +
    `[[hooks.PermissionRequest]]\nmatcher = ".*"\n[[hooks.PermissionRequest.hooks]]\ntype = "command"\ncommand = '${commands.permission}'\ntimeout = 120\n`;
  writeFileSync(path, config);
  const rpc = codexHookRpc({ binary: process.env.GRANTTAP_CODEX_TEST_BIN,
    env: { ...process.env, GRANTTAP_CODEX_DIR: home }, timeoutMs: 10_000 });
  try {
    const before = await readCodexHooks(rpc);
    assert.equal(before.hooks[0]?.trustStatus, "untrusted");
    const hook = before.hooks[0]!;
    const request = { type: "provider.hook.trust", agent: "codex", endpointId: "fixture",
      event: hook.event, key: hook.key, currentHash: hook.currentHash, requestId: "review", createdAt: Date.now() };
    assert.equal((await trustCodexHook(request, "fixture", rpc))?.ok, true);
    const persisted = readFileSync(path, "utf8");
    assert.match(persisted, /\[hooks.state.unrelated\]\nenabled = false/);
    const after = await readCodexHooks(rpc);
    assert.equal(after.hooks[0]?.trustStatus, "trusted");
    assert.equal(after.hooks[1]?.trustStatus, "untrusted");
    writeFileSync(path, persisted.replace('timeout = 30', 'timeout = 30\nstatusMessage = "Updated policy"'));
    assert.equal((await readCodexHooks(rpc)).hooks[0]?.trustStatus, "modified");
    // Only exact installed definitions may be approved. The old review cannot activate a changed hook.
    assert.equal((await trustCodexHook(request, "fixture", rpc))?.ok, false);
    assert.equal(readFileSync(path, "utf8"), persisted.replace('timeout = 30', 'timeout = 30\nstatusMessage = "Updated policy"'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
