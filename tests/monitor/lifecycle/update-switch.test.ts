import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { generateKeyPair } from "../../../packages/core/crypto";
import type { Payload, SessionInfo, TaskDispatch } from "../../../packages/protocol/schema";
import { saveRuntimeConfig } from "../../../apps/bridge/src/config";
import { startSessionMonitor } from "../../../apps/bridge/src/monitor";
import { hasPendingDeliveries, oldestDeliveryStartedAt } from "../../../apps/bridge/src/reply";
import { checkForRuntimeUpdate, runtimeUpdateLoop } from "../../../apps/bridge/src/runtime-updates";
import { UpdateDrain } from "../../../apps/bridge/src/runtime-updates/drain";
import { selectedRuntime } from "../../../apps/bridge/src/runtime-updates/selection.mjs";
import { rememberPublishedCatalog } from "../../../apps/bridge/src/session-catalog";
import { TaskDispatchInbox } from "../../../apps/bridge/src/task-dispatch";
import { startTaskDispatchMonitor } from "../../../apps/bridge/src/task-dispatch/worker/monitor";

const ROOM = "update-switch-fixture";
const PROVIDER = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), root = process.env.GRANTTAP_CONFIG_DIR;
const chat = process.argv[process.argv.indexOf("--resume") + 1];
fs.appendFileSync(path.join(root, "runs.log"), chat + "\\n");
process.stdout.write(JSON.stringify({ type: "text", data: "Fixture answer for " + chat }) + "\\n");
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(root, "finish-" + chat))) return;
  clearInterval(timer);
  process.stdout.write(JSON.stringify({ type: "end", sessionId: chat }) + "\\n");
}, 20);
`;

class Relay {
  room = ROOM;
  sent: Payload[] = [];
  offer: (job: TaskDispatch, peer: string) => void = () => {};
  constructor(readonly isConnected: boolean) {}
  setSessionKey() {}
  onMessage() { return () => {}; }
  onTaskDispatch(listener: (job: TaskDispatch, peer: string) => void) { this.offer = listener; return () => {}; }
  async send(payload: Payload) { this.sent.push(payload); }
  async sendSession(payload: Payload) { this.sent.push(payload); }
  answered(chat: string) {
    return this.sent.some(payload => payload.type === "agent.event" && payload.text === `Fixture answer for ${chat}`);
  }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), what);
}

/** One computer: an isolated configuration, a provider that runs until told to finish, and a staged-able release. */
function computer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-update-switch-"));
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
    "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_GROK_BIN"];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = root;
  process.env.GRANTTAP_GROK_BIN = join(root, "provider-fixture");
  writeFileSync(process.env.GRANTTAP_GROK_BIN, PROVIDER, { mode: 0o755 });
  saveRuntimeConfig({ meshEnabled: false, providerSettings: { claude: false, codex: false, cursor: false, grok: true } });
  const stops: Array<() => void> = [];
  const finish = (chat: string) => writeFileSync(join(root, `finish-${chat}`), "");
  t.after(async () => {
    for (const stop of stops) stop();
    finish("chat-a"); finish("chat-b");
    await until(() => !hasPendingDeliveries(), "the fixture runs end");
    for (const name of names) if (prior[name] == null) delete process.env[name]; else process.env[name] = prior[name];
    rmSync(root, { recursive: true, force: true });
  });
  const bundled = join(root, "bundled"), updates = join(root, "runtime-updates");
  mkdirSync(bundled);
  writeFileSync(join(bundled, "package.json"), JSON.stringify({ name: "granttap-mcp", version: "0.8.101" }));
  const candidate = join(updates, "versions", "0.8.102", "node_modules", "granttap-mcp");
  const release = { name: "granttap-mcp", version: "0.8.102", dist: { integrity: "sha512-" + Buffer.alloc(64, 3).toString("base64"),
    tarball: "https://registry.npmjs.org/granttap-mcp/-/granttap-mcp-0.8.102.tgz" } };
  const install = async () => {
    mkdirSync(join(candidate, "bin"), { recursive: true });
    writeFileSync(join(candidate, "package.json"), JSON.stringify({ name: "granttap-mcp", version: "0.8.102" }));
    writeFileSync(join(candidate, "bin/granttap-mcp.mjs"), "");
  };
  const own = generateKeyPair(), phone = generateKeyPair();
  const config = { relayUrl: "ws://127.0.0.1:1", room: ROOM, role: "machine" as const, deviceName: "Fixture",
    senderId: "fixture", myPublicKey: own.publicKey, mySecretKey: own.secretKey, peerPublicKey: phone.publicKey };
  const now = Date.now();
  const chats: SessionInfo[] = ["chat-a", "chat-b"].map(sessionId => ({ sessionId, agent: "grok", cwd: root, state: "idle",
    startedAt: now, lastActivityAt: now, tokensSession: 0, tokensLastTurn: 0 }));
  const message = (chat: string): TaskDispatch => ({ type: "task.dispatch", jobId: `update-switch-${chat}`, token: "a".repeat(64),
    sessionId: chat, notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
    operation: { type: "user.message", messageId: `message-${chat}`, sessionId: chat, text: "Synthetic task", createdAt: now } });
  const queue = { state: new Map<string, string>(), claims: new Map<string, number>() };
  const remote = { get: async (job: TaskDispatch) => queue.state.get(job.jobId) ?? "queued",
    claim: async (job: TaskDispatch) => {
      queue.claims.set(job.jobId, (queue.claims.get(job.jobId) ?? 0) + 1); queue.state.set(job.jobId, "accepted"); return true;
    },
    finish: async (job: TaskDispatch, outcome: string) => { queue.state.set(job.jobId, outcome); } };
  /** A monitor process: its own relay link, its own drain, the queue receiver, and the update loop. */
  const runtime = () => {
    const relay = new Relay(true), lines: string[] = [], count = { activations: 0, verifications: 0 };
    rememberPublishedCatalog(relay as never, { type: "sessions.status", machine: "Fixture", sessions: chats, generatedAt: Date.now() });
    const monitor = startSessionMonitor(new Relay(false) as never);
    const drain = new UpdateDrain({ oldestRun: oldestDeliveryStartedAt, log: line => { lines.push(line); } });
    const stopQueue = startTaskDispatchMonitor({ config, client: relay as never, isLeader: () => true, peerAllowed: () => true,
      publish: async () => {}, remote, held: () => drain.holding(), track: monitor.track });
    let pass = () => {};
    const stopUpdates = runtimeUpdateLoop({ root: bundled, directory: updates, idle: monitor.canUpdate, drain,
      latest: async () => release, activate: () => { count.activations++; },
      schedule: ((callback: () => void) => { pass = callback; return setTimeout(() => {}, 100_000); }) as typeof setTimeout,
      check: options => checkForRuntimeUpdate({ ...options, install, verify: async () => { count.verifications++; } }) });
    const stop = () => { stopUpdates(); stopQueue(); monitor.close(); };
    stops.push(stop);
    return { relay, monitor, drain, lines, count, stop, updatePass: async () => { pass(); await turn(); },
      receive: (chat: string) => relay.offer(message(chat), phone.publicKey) };
  };
  return { root, bundled, updates, candidate, queue, runtime, finish, message,
    runs: () => { try { return readFileSync(join(root, "runs.log"), "utf8").trim().split("\n"); } catch { return []; } },
    inbox: () => new TaskDispatchInbox(join(root, "task-dispatch"), ROOM) };
}

test("an update takes over between two phone messages: the first keeps its answer, the second runs once in the new runtime", async t => {
  const f = computer(t), old = f.runtime();
  old.receive("chat-a");
  await until(() => f.queue.state.get(f.message("chat-a").jobId) === "completed", "the first message is delivered");
  assert.equal(old.monitor.canUpdate(), false, "its provider run is still going");

  await old.updatePass();
  assert.equal(old.drain.holding(), true, "the staged release is valid, so new work waits for it");
  old.receive("chat-b");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(f.queue.claims.get(f.message("chat-b").jobId), undefined, "the second message is not claimed from the relay");
  assert.equal(f.inbox().status(f.message("chat-b").jobId)?.phase, "staged", "it is kept on this computer");
  assert.deepEqual(f.runs(), ["chat-a"]);
  assert.equal(selectedRuntime(f.bundled, f.updates), f.bundled, "the running work is not cut off");

  f.finish("chat-a");
  await until(() => old.relay.answered("chat-a"), "the first run's answer reaches the phone from the monitor that started it");
  await until(() => old.monitor.canUpdate(), "nothing is in flight any more");
  await old.updatePass();
  assert.equal(selectedRuntime(f.bundled, f.updates), f.candidate);
  assert.equal(old.count.activations, 1);
  assert.equal(old.count.verifications, 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(f.runs(), ["chat-a"], "nothing starts in the monitor that is being replaced");
  assert.deepEqual(old.lines.map(line => line.split(" ").slice(2, 4).join(" ")), ["is ready.", "takes over:"]);
  old.stop();

  const next = f.runtime();
  await until(() => f.queue.state.get(f.message("chat-b").jobId) === "completed", "the new runtime delivers the waiting message");
  f.finish("chat-b");
  await until(() => next.relay.answered("chat-b"), "and its answer reaches the phone");
  assert.deepEqual(f.runs(), ["chat-a", "chat-b"], "each message ran exactly once");
  assert.deepEqual([...f.queue.claims.values()], [1, 1]);
  assert.deepEqual(f.inbox().records().filter(record => record.code !== undefined), [], "no response is left unconfirmed");
  const refused = [...old.relay.sent, ...next.relay.sent]
    .filter(payload => payload.type === "delivery.receipt" && payload.status === "rejected");
  assert.deepEqual(refused, [], "and no message was refused");
});
