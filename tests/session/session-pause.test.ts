import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../../packages/protocol/schema";
import { MeshHandoffPrepare, Payload as PayloadSchema } from "../../packages/protocol/schema";
import { runHook } from "../provider-hook-harness";

class FakeRelay {
  readonly room = "pause-test-room";
  isConnected = true;
  sent: Payload[] = [];
  private keys = new Map<string, string>();
  onMessage() { return () => {}; }
  async send(payload: Payload) { this.sent.push(payload); }
  setSessionKey(sessionId: string, key: string) { this.keys.set(sessionId, key); }
  async sendSession(payload: Payload) { this.sent.push(payload); }
}

test("the wire carries a pause, its answer, and a push flag on a handoff", () => {
  const control = PayloadSchema.parse({
    type: "session.control", sessionId: "chat", action: "pause", createdAt: 1,
  });
  assert.equal(control.type, "session.control");
  const result = PayloadSchema.parse({
    type: "session.control.result", sessionId: "chat", action: "resume", ok: true,
    message: "Resumed", createdAt: 1,
  });
  assert.equal(result.type, "session.control.result");
  assert.throws(() => PayloadSchema.parse({
    type: "session.control", sessionId: "chat", action: "stop", createdAt: 1,
  }), "only pause and resume exist");
  const prepare = MeshHandoffPrepare.parse({
    type: "mesh.handoff.prepare", sessionId: "s", projectId: "p", taskId: "t",
    targetProvider: "codex", targetComputer: "Air", createdAt: 1, checkpoint: true, push: true,
  });
  assert.equal(prepare.push, true);
});

test("a paused chat is refused every tool by every hook until it is resumed", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-pause-config-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  const {
    blockedSessionCapability, isSessionPaused, loadRuntimeConfig, pausedSessionBlock,
    PAUSED_SESSION_REASON, setSessionPaused, setSessionShellAllowed,
  } = await import(`../../apps/bridge/src/config/index.ts?pause=${Date.now()}`);

  assert.equal(isSessionPaused("chat-a"), false);
  assert.equal(pausedSessionBlock("chat-a"), null);
  setSessionPaused("chat-a", true);
  setSessionPaused("chat-a", true);
  assert.deepEqual(loadRuntimeConfig().pausedSessions, ["chat-a"]);
  assert.equal(isSessionPaused("chat-a"), true);
  assert.equal(isSessionPaused(undefined), false);
  assert.equal(pausedSessionBlock("chat-a")?.kind, "session");
  assert.throws(() => setSessionPaused("", true), TypeError);

  // The hold outranks the chat's own capability rules: a chat that still
  // allows its shell is refused the shell all the same.
  setSessionShellAllowed("chat-a", true);
  const shell = blockedSessionCapability("chat-a", "Bash", { command: "ls" });
  assert.equal(shell?.reason, PAUSED_SESSION_REASON);
  assert.equal(blockedSessionCapability("chat-a", "mcp__github__search", {})?.kind, "session");
  assert.equal(blockedSessionCapability("chat-b", "Bash", { command: "ls" }), null);

  const claude = runHook("claude", configDir, {
    session_id: "chat-a", tool_name: "Bash", tool_input: { command: "npm test" },
  });
  assert.equal((claude.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
  assert.match(String((claude.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /paused/);
  const codex = runHook("codex", configDir, {
    session_id: "chat-a", tool_use_id: "call-1", tool_name: "shell_command", tool_input: { command: "npm test" },
  });
  assert.match(JSON.stringify(codex), /"behavior":"deny"[^}]*paused/);
  const codexPolicy = runHook("codexPolicy", configDir, {
    session_id: "chat-a", tool_use_id: "call-2", tool_name: "shell_command", tool_input: { command: "npm test" },
  });
  assert.equal((codexPolicy.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");

  setSessionPaused("chat-a", false);
  assert.deepEqual(loadRuntimeConfig().pausedSessions, []);
  assert.equal(blockedSessionCapability("chat-a", "Bash", { command: "ls" }), null);
});

test("a pause stops the delivery in flight and refuses a new one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-pause-delivery-"));
  const stub = join(dir, "sleepy.mjs");
  await writeFile(stub, "setTimeout(() => process.stdout.write('late'), 20000);\n");
  const { abortProcesses, runProcess, runningProcessCount, STOPPED_ERROR } =
    await import(`../../apps/bridge/src/reply/process/index.ts?pause=${Date.now()}`);

  const untracked = runProcess(process.execPath, ["-e", "process.stdout.write('done')"], dir, 5_000,
    (stdout: string) => ({ ok: true, text: stdout }));
  assert.deepEqual(await untracked, { ok: true, text: "done" });
  assert.equal(abortProcesses("nobody"), 0);

  const running = runProcess(process.execPath, [stub], dir, 30_000,
    (stdout: string) => ({ ok: true, text: stdout }), undefined, "chat-a");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(runningProcessCount("chat-a"), 1);
  assert.equal(abortProcesses("chat-a"), 1);
  assert.deepEqual(await running, { ok: false, error: STOPPED_ERROR });
  assert.equal(runningProcessCount("chat-a"), 0);

  const configDir = join(dir, "config");
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  const { setSessionPaused } = await import(`../../apps/bridge/src/config/index.ts?pause2=${Date.now()}`);
  const { deliverToSession, stopDeliveries } = await import(`../../apps/bridge/src/reply/index.ts?pause=${Date.now()}`);
  setSessionPaused("chat-held", true);
  const refused = await deliverToSession({
    sessionId: "chat-held", agent: "claude", state: "idle", startedAt: 1, lastActivityAt: 1,
    tokensSession: 0, tokensLastTurn: 0, cwd: dir,
  }, "keep going");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /paused/);
  assert.equal(stopDeliveries("chat-held"), 0);
});

test("a pause stops an owned descendant before it can keep working", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-pause-tree-"));
  const childScript = join(dir, "descendant.mjs");
  const parentScript = join(dir, "parent.mjs");
  const ready = join(dir, "ready");
  const marker = join(dir, "late-effect");
  await writeFile(childScript, `import { writeFileSync } from "node:fs";
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "continued"), 650);
`);
  await writeFile(parentScript, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(ready)}, "started");
setInterval(() => {}, 1000);
`);
  const { abortProcesses, runProcess, STOPPED_ERROR } =
    await import(`../../apps/bridge/src/reply/process/index.ts?tree=${Date.now()}`);
  const pending = runProcess(process.execPath, [parentScript], dir, 5_000,
    (stdout: string) => ({ ok: true, text: stdout }), undefined, "owned-tree");
  let started = false;
  for (let attempt = 0; attempt < 100 && !started; attempt++) {
    started = await readFile(ready).then(() => true, () => false);
    if (!started) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(started, true, "the descendant was launched before cancellation");
  assert.equal(abortProcesses("owned-tree"), 1);
  assert.deepEqual(await pending, { ok: false, error: STOPPED_ERROR });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(await readFile(marker).then(() => true, () => false), false,
    "a stopped run must not leave its local descendant working");
});

test("the monitor answers a pause at once and continues a resumed chat in the background", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-pause-monitor-"));
  const repo = join(root, "repo");
  const sessions = join(root, "sessions");
  const session = join(sessions, "project", "grok-held");
  await mkdir(session, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(session, "summary.json"), JSON.stringify({
    info: { id: "grok-held", cwd: repo }, generated_title: "Held work",
    created_at: Date.now() - 2_000, updated_at: Date.now(), current_model_id: "grok-build",
  }));
  await writeFile(join(session, "chat_history.jsonl"), `${JSON.stringify({
    role: "user", timestamp: Date.now(), content: "Do the thing",
  })}\n`);
  const promptFile = join(root, "prompt.txt");
  const bin = join(root, "grok-fixture");
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").writeFileSync(${JSON.stringify(promptFile)}, args[args.indexOf("-p") + 1]);
process.stdout.write(JSON.stringify({ type: "text", data: "continued" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId: "grok-held" }) + "\\n");
`, { mode: 0o755 });
  const env = { ...process.env };
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  process.env.GRANTTAP_GROK_SESSIONS_DIR = sessions;
  process.env.GRANTTAP_GROK_BIN = bin;
  t.after(() => {
    for (const key of ["GRANTTAP_CONFIG_DIR", "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_GROK_BIN"]) {
      if (env[key] == null) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  const { handleSessionControl, RESUME_PROMPT } = await import(`../../apps/bridge/src/monitor/index.ts?pause=${Date.now()}`);
  const { loadRuntimeConfig } = await import(`../../apps/bridge/src/config/index.ts?pause3=${Date.now()}`);
  const fake = new FakeRelay();
  const results = () => fake.sent.filter((item) => item.type === "session.control.result") as Array<
    Extract<Payload, { type: "session.control.result" }>
  >;

  await handleSessionControl(fake as never, {
    type: "session.control", sessionId: "grok-held", action: "pause", createdAt: Date.now(),
  });
  assert.deepEqual(loadRuntimeConfig().pausedSessions, ["grok-held"]);
  assert.equal(results().at(-1)?.ok, true);
  assert.match(results().at(-1)?.message ?? "", /refused until you resume/);

  await handleSessionControl(fake as never, {
    type: "session.control", sessionId: "grok-held", action: "resume", createdAt: Date.now(),
  });
  assert.deepEqual(loadRuntimeConfig().pausedSessions, []);
  assert.match(results().at(-1)?.message ?? "", /allowed again/);

  const continued = new Promise<void>((resolve) => {
    void handleSessionControl(fake as never, {
      type: "session.control", sessionId: "grok-held", action: "resume", continue: true, createdAt: Date.now(),
    }, resolve);
  });
  await continued;
  assert.match(results().at(-1)?.message ?? "", /asked to continue/);
  assert.equal(await readFile(promptFile, "utf8"), RESUME_PROMPT);

  await handleSessionControl(fake as never, {
    type: "session.control", sessionId: " ", action: "pause", createdAt: Date.now(),
  });
  assert.equal(results().at(-1)?.ok, false);
});
