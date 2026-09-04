import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../packages/protocol/schema";
import { saveRuntimeConfig } from "../apps/bridge/src/config";

class FakeRelay {
  readonly room = "monitor-test-room";
  isConnected = false;
  sent: Payload[] = [];
  private listener?: (payload: Payload) => boolean | void | Promise<boolean | void>;
  private keys = new Map<string, string>();

  onMessage(listener: (payload: Payload) => boolean | void | Promise<boolean | void>) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(payload: Payload) { return this.listener?.(payload); }
  async send(payload: Payload) { this.sent.push(payload); }
  setSessionKey(sessionId: string, key: string) { this.keys.set(sessionId, key); }
  async sendSession(payload: Payload) { this.sent.push(payload); }
}

async function grokFixture(root: string): Promise<{ sessions: string; repo: string; bin: string }> {
  const repo = join(root, "repo");
  const sessions = join(root, "sessions");
  const session = join(sessions, "project", "grok-existing");
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "summary.json"), JSON.stringify({
    info: { id: "grok-existing", cwd: repo }, generated_title: "Reconnect verification",
    created_at: Date.now() - 2_000, updated_at: Date.now(), current_model_id: "grok-build",
  }));
  await writeFile(join(session, "chat_history.jsonl"), `${JSON.stringify({
    role: "user", timestamp: Date.now(), content: "Verify reconnect",
  })}\n`);
  const skill = join(repo, ".agents", "skills", "review");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\n");
  const bin = join(root, "grok-fixture");
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const selectedAt = args.indexOf("--session-id");
const resumedAt = args.indexOf("--resume");
const sessionId = resumedAt >= 0 ? args[resumedAt + 1] : args[selectedAt + 1];
process.stdout.write(JSON.stringify({ type: "text", data: "Grok completed" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId }) + "\\n");
`, { mode: 0o755 });
  return { sessions, repo, bin };
}

test("monitor routes settings and task messages without weakening provider gates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-monitor-routing-"));
  const fixture = await grokFixture(root);
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  process.env.GRANTTAP_GROK_SESSIONS_DIR = fixture.sessions;
  process.env.GRANTTAP_GROK_BIN = fixture.bin;
  const engineFlag = process.env.GRANTTAP_ENGINE_ENABLED;
  const policyFlag = process.env.GRANTTAP_PROJECT_POLICY_ENABLED;
  delete process.env.GRANTTAP_ENGINE_ENABLED;
  delete process.env.GRANTTAP_PROJECT_POLICY_ENABLED;
  t.after(() => {
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    delete process.env.GRANTTAP_GROK_BIN;
    if (engineFlag == null) delete process.env.GRANTTAP_ENGINE_ENABLED;
    else process.env.GRANTTAP_ENGINE_ENABLED = engineFlag;
    if (policyFlag == null) delete process.env.GRANTTAP_PROJECT_POLICY_ENABLED;
    else process.env.GRANTTAP_PROJECT_POLICY_ENABLED = policyFlag;
  });
  const {
    handleUserMessage, startSessionMonitor,
  } = await import("../apps/bridge/src/monitor");
  const fake = new FakeRelay();
  const monitor = startSessionMonitor(fake as never);
  t.after(() => monitor.close());
  const emit = (payload: Payload) => fake.emit(payload);

  assert.equal(await emit({
    type: "user.message", messageId: "correlated", requestId: "ask", text: "answer", createdAt: Date.now(),
  }), false);
  assert.equal(await emit({
    type: "config.set", provider: "grok", providerEnabled: false,
    meshEnabled: false, createdAt: Date.now(),
  }), true);
  for (const payload of [
    { type: "session.access.set", sessionId: "grok-existing", accessLevel: "workspace", createdAt: Date.now() },
    { type: "session.mcp.set", sessionId: "grok-existing", serverName: "github", allowed: false, createdAt: Date.now() },
    { type: "session.skill.set", sessionId: "grok-existing", skillName: "review", allowed: false, createdAt: Date.now() },
    { type: "session.shell.set", sessionId: "grok-existing", allowed: false, createdAt: Date.now() },
    { type: "session.subscribe", sessionId: "grok-existing", active: true, createdAt: Date.now() },
    { type: "session.subscribe", sessionId: "grok-existing", active: true, createdAt: Date.now() },
    { type: "session.events", sessionId: "grok-existing", createdAt: Date.now() },
    { type: "sessions.refresh", createdAt: Date.now() },
    { type: "session.compact", sessionId: "missing", createdAt: Date.now() },
  ] as Payload[]) assert.equal(await emit(payload), true);
  assert.equal(await emit({
    type: "mesh.snapshot", sessionId: "project", projectId: "project",
    project: { projectId: "project", name: "Project", canonicalRepositoryId: "repo", createdAt: Date.now() },
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: Date.now(),
  }), false);

  const base = { type: "user.message" as const, text: "Verify", createdAt: Date.now() };
  await handleUserMessage(fake as never, { ...base, messageId: "disabled-new", agent: "grok" });
  assert.match(JSON.stringify(fake.sent.at(-1)), /disabled in GrantTap Settings/);
  saveRuntimeConfig({
    meshEnabled: true,
    providerSettings: { claude: true, codex: true, cursor: true, grok: true },
  });
  assert.equal(await emit({
    type: "project.policy.set", sessionId: "project", projectId: "project",
    expectedRevision: 0, createdAt: Date.now(),
    policy: {
      projectId: "project", revision: 1, enforcement: "best_available", rules: [],
    },
  }), false);
  await handleUserMessage(fake as never, {
    ...base, messageId: "unknown-workspace", agent: "grok", cwd: join(root, "unknown"),
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /not one of the agent workspaces/);
  await handleUserMessage(fake as never, {
    ...base, messageId: "missing-session", sessionId: "missing",
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /no longer available/);

  saveRuntimeConfig({ providerSettings: { claude: true, codex: true, cursor: true, grok: false } });
  await handleUserMessage(fake as never, {
    ...base, messageId: "disabled-existing", sessionId: "grok-existing",
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /no longer available/);
  saveRuntimeConfig({ providerSettings: { claude: true, codex: true, cursor: true, grok: true } });
  await handleUserMessage(fake as never, {
    ...base, messageId: "mcp-missing", sessionId: "grok-existing", preferredMcp: "github",
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /MCP server is not allowed/);
  await handleUserMessage(fake as never, {
    ...base, messageId: "skill-missing", sessionId: "grok-existing", skill: "missing",
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /skill is no longer available/);
  await handleUserMessage(fake as never, {
    ...base, messageId: "skill-disabled", sessionId: "grok-existing", skill: "review",
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /skill is disabled/);

  saveRuntimeConfig({ sessionSkillsDisabled: {} });
  await handleUserMessage(fake as never, {
    ...base, messageId: "existing-success", sessionId: "grok-existing", skill: "review",
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /Grok completed/);
  // The delivery is journaled for the chat, so a live session learns of it on its next prompt.
  const { runJournal } = await import("../apps/bridge/src/mesh/journal");
  const journal = runJournal("grok-existing");
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.ok, true);
  assert.match(journal[0]?.outcome ?? "", /Grok completed/);
  assert.equal(journal[0]?.prompt, "Verify");
  await handleUserMessage(fake as never, {
    ...base, messageId: "new-success", agent: "grok", cwd: fixture.repo,
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /Grok completed/);
});
