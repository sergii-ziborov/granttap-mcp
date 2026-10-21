import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveRuntimeConfig } from "../../../config";
import { startSessionMonitor } from "../..";
import type { Payload } from "../../../../../../packages/protocol/schema";

test("a held usage report cannot delay the next current chat catalog", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-usage-priority-"));
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
    "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", "GRANTTAP_GROK_SESSIONS_DIR"];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = root;
  saveRuntimeConfig({ meshEnabled: false,
    providerSettings: { claude: false, codex: false, cursor: false, grok: false } });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const usageEntered = new Promise<void>(resolve => { entered = resolve; });
  let catalogs = 0;
  const client = { room: "isolated", isConnected: true, onMessage: () => () => {}, setSessionKey: () => {},
    sendSession: async () => {}, send: async (payload: Payload) => {
      if (payload.type === "sessions.status") catalogs++;
      if (payload.type === "capability.usage.status") { entered(); await held; }
    } };
  const monitor = startSessionMonitor(client as never);
  t.after(async () => {
    release(); monitor.close(); await new Promise<void>(resolve => setImmediate(resolve));
    for (const name of names) {
      if (prior[name] == null) delete process.env[name]; else process.env[name] = prior[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const first = monitor.publish();
  await usageEntered;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([(async () => { await first; await monitor.publish(); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Usage blocked the chat catalog")), 2_000); })]);
    assert.ok(catalogs >= 2, "The next catalog reaches the relay before the usage transfer finishes");
  } finally { clearTimeout(timer); release(); }
});
