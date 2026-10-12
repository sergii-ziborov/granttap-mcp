import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../../../../../packages/protocol/schema";
import { saveRuntimeConfig } from "../../config";
import { startSessionMonitor } from "../../monitor";

test("a published chat remains readable without rescanning the discovery window", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-catalog-reply-"));
  const logs = join(root, "claude", "project");
  mkdirSync(logs, { recursive: true });
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CODEX_DIR"];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = join(root, "claude");
  process.env.GRANTTAP_CODEX_DIR = join(root, "empty");
  t.after(() => {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  });
  const at = Date.now() - 60_000;
  const write = (id: string, time: number) => {
    const path = join(logs, `${id}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "user", sessionId: id, cwd: root,
      timestamp: new Date(time).toISOString(),
      message: { role: "user", content: "Cached current message" } }) + "\n");
    utimesSync(path, time / 1000, time / 1000);
  };
  write("published-chat",at);
  saveRuntimeConfig({ meshEnabled: false,
    providerSettings: { claude: true, codex: false, cursor: false, grok: false } });
  let receive!: (payload: Payload) => boolean | void | Promise<boolean | void>;
  const sent: Payload[] = [];
  const relay = { room: "known-publisher", isConnected: true,
    onMessage: (callback: typeof receive) => { receive = callback; return () => {}; },
    setSessionKey: () => {},
    send: async (payload: Payload) => { sent.push(payload); },
    sendSession: async (payload: Payload) => { sent.push(payload); } };
  const monitor = startSessionMonitor(relay as never);
  t.after(() => monitor.close());
  await monitor.publish();
  assert.ok(sent.some(payload => payload.type === "sessions.status"
    && payload.sessions.some(chat => chat.sessionId === "published-chat")));
  for (let index = 0; index < 205; index++) write(`new-chat-${index}`, at + 10_000 + index);
  sent.length = 0;
  await receive({ type: "session.events", sessionId: "published-chat", history: true, createdAt: Date.now() });
  assert.ok(sent.some(payload => payload.type === "session.activity" && payload.sessionId === "published-chat"
    && payload.entries.some(entry => entry.text === "Cached current message")),
    "the published native chat must remain readable while discovery changes");
});
