import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveRuntimeConfig } from "../../../apps/bridge/src/config";
import { startSessionMonitor } from "../../../apps/bridge/src/monitor";
import { ownedHookCommands } from "../../../apps/bridge/src/codex-hook-trust";

test("the current catalog reaches the phone before a stalled provider hook probe finishes", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-first-catalog-"));
  const empty = join(root, "empty"); mkdirSync(empty);
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_BIN",
    "GRANTTAP_CODEX_SESSIONS_DIR", "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_CURSOR_DIR"];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = empty;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const bin = join(root, "codex-probe");
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume(); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
  process.env.GRANTTAP_CODEX_BIN = bin;
  const commands = ownedHookCommands();
  writeFileSync(join(empty, "config.toml"), `[[hooks.PermissionRequest]]\nmatcher = ".*"\n[[hooks.PermissionRequest.hooks]]\ntype = "command"\ncommand = '${commands.permission}'\ntimeout = 120\n`);
  saveRuntimeConfig({ meshEnabled: false, providerSettings: { claude: true, codex: true, cursor: false, grok: false } });
  let received!: () => void;
  const catalog = new Promise<void>(resolve => { received = resolve; });
  const relay = { room: "isolated", isConnected: true,
    onMessage: () => () => {}, setSessionKey: () => {}, sendSession: async () => {},
    send: async (payload: { type: string }) => { if (payload.type === "sessions.status") received(); } };
  const monitor = startSessionMonitor(relay as never);
  t.after(() => { monitor.close(); for (const name of names) {
    if (prior[name] == null) delete process.env[name]; else process.env[name] = prior[name]; }
    rmSync(root, { recursive: true, force: true }); });
  void monitor.publish();
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([catalog, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Catalog was blocked by provider discovery")), 2_500); })]); }
  finally { clearTimeout(timer); }
  assert.ok(true);
});
