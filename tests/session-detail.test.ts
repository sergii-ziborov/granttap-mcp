import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayClient } from "../packages/core/relay-client";
import type { Payload, SessionInfo, SessionsStatus } from "../packages/protocol/schema";
import {
  boundedCatalogHistory,
  startSessionMonitor,
} from "../apps/bridge/src/monitor";
import { loadRuntimeConfig } from "../apps/bridge/src/config";

type Listener = (payload: Payload) => boolean | Promise<boolean>;

class FakeRelayClient {
  readonly room = "session-detail-test-room";
  isConnected = true;
  sent: Payload[] = [];
  sessionSent: Array<{ payload: Payload; sessionId: string }> = [];
  private listener?: Listener;

  onMessage(listener: Listener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  setSessionKey(): void {}

  async send(payload: Payload): Promise<void> {
    this.sent.push(payload);
  }

  async sendSession(payload: Payload, sessionId: string): Promise<void> {
    this.sessionSent.push({ payload, sessionId });
  }

  async receive(payload: Payload): Promise<boolean> {
    assert.ok(this.listener, "monitor listener is installed");
    return await this.listener(payload);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for monitor publish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function session(id: string, lastActivityAt: number): SessionInfo {
  return {
    sessionId: id,
    agent: "codex",
    state: "idle",
    startedAt: lastActivityAt,
    lastActivityAt,
    tokensSession: 1,
    tokensLastTurn: 1,
  };
}

test("bounded history retains a subscribed task outside the newest catalog window", () => {
  const history = Array.from({ length: 60 }, (_, index) => session(`session-${index}`, 60 - index));
  const bounded = boundedCatalogHistory(history, new Set(["session-59"]), 40);
  assert.equal(bounded.length, 40);
  assert.equal(bounded.some((item) => item.sessionId === "session-59"), true);
  assert.equal(bounded.some((item) => item.sessionId === "session-39"), false);
});

test("subscribe republishes rich catalog detail and session.events can fetch it again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-session-detail-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const claudeRoot = join(root, "claude");
  const codexRoot = join(root, "codex");
  const project = join(claudeRoot, "project");
  await mkdir(project, { recursive: true });
  await mkdir(codexRoot, { recursive: true });

  const sessionId = "detail-session";
  const timestamp = new Date().toISOString();
  await writeFile(join(project, `${sessionId}.jsonl`), [
    { sessionId, cwd: root, timestamp, type: "user", message: { role: "user", content: "Open detail" } },
    { sessionId, cwd: root, timestamp, type: "assistant",
      message: { role: "assistant", content: [
        { type: "text", text: "Visible answer" },
        { type: "tool_use", id: "shell-detail", name: "Bash",
          input: { command: "OPENAI_API_KEY=sk-proj-detailsecret123 git status --short" } },
      ] } },
    { sessionId, cwd: root, timestamp, type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "shell-detail", content: "private command result" },
    ] } },
  ].map((row) => JSON.stringify(row)).join("\n"));

  const globalSkill = join(home, ".agents", "skills", "global-detail");
  const projectSkill = join(root, ".cursor", "skills", "project-detail");
  await mkdir(globalSkill, { recursive: true });
  await mkdir(projectSkill, { recursive: true });
  await writeFile(join(globalSkill, "SKILL.md"), [
    "---",
    "name: global-detail",
    "description: Global detail skill.",
    "---",
  ].join("\n"));
  await writeFile(join(projectSkill, "SKILL.md"), [
    "---",
    "name: project-detail",
    "description: Project detail skill.",
    "---",
  ].join("\n"));

  const previous = {
    HOME: process.env.HOME,
    config: process.env.GRANTTAP_CONFIG_DIR,
    claude: process.env.GRANTTAP_CLAUDE_PROJECTS_DIR,
    codex: process.env.GRANTTAP_CODEX_SESSIONS_DIR,
  };
  process.env.HOME = home;
  process.env.GRANTTAP_CONFIG_DIR = config;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = claudeRoot;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = codexRoot;

  const relay = new FakeRelayClient();
  const monitor = startSessionMonitor(relay as unknown as RelayClient);
  t.after(() => {
    monitor.close();
    for (const [name, value] of Object.entries({
      HOME: previous.HOME,
      GRANTTAP_CONFIG_DIR: previous.config,
      GRANTTAP_CLAUDE_PROJECTS_DIR: previous.claude,
      GRANTTAP_CODEX_SESSIONS_DIR: previous.codex,
    })) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  await monitor.publish();
  const initial = relay.sent.find((payload): payload is SessionsStatus => payload.type === "sessions.status");
  assert.ok(initial);
  assert.equal(initial.sessions.find((item) => item.sessionId === sessionId)?.skills, undefined);
  assert.equal(initial.sessions.find((item) => item.sessionId === sessionId)?.shellAllowed, true);
  const usage = relay.sent.find((payload) => payload.type === "capability.usage.status");
  assert.deepEqual(usage?.events[0]?.deepLinkTarget, {
    kind: "chat",
    roomId: relay.room,
    sessionId,
  });
  assert.match(usage?.events[0]?.commandPreview ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(usage), /detailsecret|private command result/);

  const beforeSubscribeStatuses = relay.sent.filter((payload) => payload.type === "sessions.status").length;
  assert.equal(await relay.receive({
    type: "session.subscribe",
    sessionId,
    active: true,
    createdAt: Date.now(),
  }), true);
  await waitFor(() => relay.sent.filter((payload) => payload.type === "sessions.status").length > beforeSubscribeStatuses);
  await waitFor(() => relay.sessionSent.some((item) => item.payload.type === "session.activity"));

  const rich = relay.sent.filter((payload): payload is SessionsStatus => payload.type === "sessions.status").at(-1);
  assert.ok(rich);
  assert.deepEqual(
    rich.sessions.find((item) => item.sessionId === sessionId)?.skills?.map((skill) => skill.name),
    ["global-detail", "project-detail"],
  );
  assert.equal(
    rich.sessions.find((item) => item.sessionId === sessionId)?.skills?.every((skill) => skill.allowed),
    true,
  );
  const firstActivity = relay.sessionSent.find((item) => item.payload.type === "session.activity");
  assert.equal(firstActivity?.sessionId, sessionId);
  assert.match(JSON.stringify(firstActivity?.payload), /Open detail|Visible answer/);

  const beforeEvents = relay.sessionSent.filter((item) => item.payload.type === "session.activity").length;
  assert.equal(await relay.receive({ type: "session.events", sessionId, createdAt: Date.now() }), true);
  await waitFor(() => relay.sessionSent.filter((item) => item.payload.type === "session.activity").length > beforeEvents);

  const beforeRefresh = relay.sent.filter((payload) => payload.type === "sessions.status").length;
  assert.equal(await relay.receive({ type: "sessions.refresh", createdAt: Date.now() }), true);
  await waitFor(() => relay.sent.filter((payload) => payload.type === "sessions.status").length > beforeRefresh);
  const refreshed = relay.sent.filter((payload): payload is SessionsStatus => payload.type === "sessions.status").at(-1);
  assert.ok(refreshed?.history);

  let statusCount = relay.sent.filter((payload) => payload.type === "sessions.status").length;
  assert.equal(await relay.receive({
    type: "session.skill.set",
    sessionId,
    skillName: "project-detail",
    allowed: false,
    createdAt: Date.now(),
  }), true);
  await waitFor(() => relay.sent.filter((payload) => payload.type === "sessions.status").length > statusCount);
  statusCount = relay.sent.filter((payload) => payload.type === "sessions.status").length;
  assert.equal(await relay.receive({
    type: "session.shell.set",
    sessionId,
    allowed: false,
    createdAt: Date.now(),
  }), true);
  await waitFor(() => relay.sent.filter((payload) => payload.type === "sessions.status").length > statusCount);

  const toggled = relay.sent
    .filter((payload): payload is SessionsStatus => payload.type === "sessions.status")
    .at(-1);
  const toggledSession = toggled?.sessions.find((item) => item.sessionId === sessionId);
  assert.equal(
    toggledSession?.skills?.find((skill) => skill.name === "project-detail")?.allowed,
    false,
  );
  assert.equal(toggledSession?.shellAllowed, false);
  assert.deepEqual(loadRuntimeConfig().sessionSkillsDisabled[sessionId], ["project-detail"]);
  assert.equal(loadRuntimeConfig().sessionShellDisabled.includes(sessionId), true);
});
