import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveRuntimeConfig } from "../../../config";
import { startSessionMonitor } from "../../../monitor";

test("cold catalog discovery lets queued relay work run before publishing the catalog", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-catalog-responsive-"));
  const logs = join(root, "logs"); mkdirSync(logs);
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
    "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CURSOR_DIR", "GRANTTAP_GROK_SESSIONS_DIR"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = root;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = logs;
  for (let index = 0; index < 8; index++) {
    writeFileSync(join(logs, `rollout-${index}.jsonl`), JSON.stringify({ type: "session_meta",
      timestamp: new Date().toISOString(), payload: { id: `responsive-${index}`, cwd: root } }) + "\n");
  }
  saveRuntimeConfig({ meshEnabled: false,
    providerSettings: { codex: true, claude: false, cursor: false, grok: false } });
  let catalogPublished = false;
  let relayWorkBeforeCatalog = false;
  let queued = false;
  const relay = { room: "isolated", isConnected: true, onMessage: () => () => {}, setSessionKey: () => {},
    sendSession: async () => {}, send: async (payload: { type: string }) => {
      if (payload.type === "machine.heartbeat" && !queued) {
        queued = true;
        setImmediate(() => { relayWorkBeforeCatalog = !catalogPublished; });
      }
      if (payload.type === "sessions.status") catalogPublished = true;
    } };
  const monitor = startSessionMonitor(relay as never);
  t.after(async () => {
    monitor.close(); await new Promise<void>(resolve => setImmediate(resolve));
    for (const name of names) {
      if (previous[name] == null) delete process.env[name]; else process.env[name] = previous[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  await monitor.publish();
  assert.equal(catalogPublished, true);
  assert.equal(relayWorkBeforeCatalog, true, "Native discovery must not starve queued relay callbacks");
});

test("reconnected transport republishes the catalog without waiting for the periodic tick", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-catalog-reconnect-"));
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
    "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CURSOR_DIR", "GRANTTAP_GROK_SESSIONS_DIR"];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = root;
  saveRuntimeConfig({ meshEnabled: false,
    providerSettings: { codex: false, claude: false, cursor: false, grok: false } });
  let connected = () => {};
  let received!: () => void;
  const catalog = new Promise<void>(resolve => { received = resolve; });
  const relay = { room: "isolated", isConnected: false, onMessage: () => () => {},
    onConnected: (callback: () => void) => { connected = callback; return () => { connected = () => {}; }; },
    setSessionKey: () => {}, sendSession: async () => {},
    send: async (payload: { type: string }) => { if (payload.type === "sessions.status") received(); } };
  const monitor = startSessionMonitor(relay as never);
  t.after(async () => {
    monitor.close(); await new Promise<void>(resolve => setImmediate(resolve));
    for (const name of names) {
      if (prior[name] == null) delete process.env[name]; else process.env[name] = prior[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  relay.isConnected = true;
  connected();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([catalog, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Reconnected catalog waited for the periodic interval")), 1_000);
    })]);
  } finally { clearTimeout(timer); }
  monitor.close();
  connected();
});

test("closing a monitor during discovery prevents a late catalog publication", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-catalog-close-"));
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
    "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CURSOR_DIR", "GRANTTAP_GROK_SESSIONS_DIR"];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = root;
  saveRuntimeConfig({ meshEnabled: false,
    providerSettings: { codex: false, claude: false, cursor: false, grok: false } });
  const sent: string[] = [];
  const relay = { room: "isolated", isConnected: true, onMessage: () => () => {},
    setSessionKey: () => {}, sendSession: async () => {},
    send: async (payload: { type: string }) => { sent.push(payload.type); } };
  const monitor = startSessionMonitor(relay as never);
  t.after(() => {
    monitor.close();
    for (const name of names) {
      if (prior[name] == null) delete process.env[name]; else process.env[name] = prior[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const publishing = monitor.publish();
  await new Promise<void>(resolve => setImmediate(resolve));
  monitor.close();
  await publishing;
  assert.ok(!sent.includes("sessions.status"), "A closed monitor must not publish after yielding");
});
