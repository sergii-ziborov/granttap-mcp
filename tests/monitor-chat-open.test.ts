import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../packages/protocol/schema";
import { saveRuntimeConfig } from "../apps/bridge/src/config";

class FakeRelay {
  readonly room = "monitor-chat-open-room";
  isConnected = true;
  sent: Payload[] = [];
  private listener?: (payload: Payload) => boolean | void | Promise<boolean | void>;

  onMessage(listener: (payload: Payload) => boolean | void | Promise<boolean | void>) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(payload: Payload) { return this.listener?.(payload); }
  async send(payload: Payload) { this.sent.push(payload); }
  setSessionKey() { /* the transcript key is irrelevant to routing */ }
  async sendSession(payload: Payload) { this.sent.push(payload); }
}

async function grokFixture(root: string): Promise<{ sessions: string; bin: string }> {
  const repo = join(root, "repo");
  const sessions = join(root, "sessions");
  const session = join(sessions, "project", "grok-open");
  await mkdir(repo, { recursive: true });
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "summary.json"), JSON.stringify({
    info: { id: "grok-open", cwd: repo }, generated_title: "Chat open latency",
    created_at: Date.now() - 2_000, updated_at: Date.now(), current_model_id: "grok-build",
  }));
  await writeFile(join(session, "chat_history.jsonl"), `${JSON.stringify({
    role: "user", timestamp: Date.now(), content: "First transcript line",
  })}\n`);
  const bin = join(root, "grok-fixture");
  await writeFile(bin, "#!/usr/bin/env node\n", { mode: 0o755 });
  return { sessions, bin };
}

/** Wait for a recorded payload rather than a fixed sleep, so the test is not timing-flaky. */
async function waitForActivity(relay: FakeRelay, sessionId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (relay.sent.some((payload) => payload.type === "session.activity"
      && payload.sessionId === sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("opening a chat delivers its transcript without waiting for the next tick", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-monitor-chat-open-"));
  const fixture = await grokFixture(root);
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  process.env.GRANTTAP_GROK_SESSIONS_DIR = fixture.sessions;
  process.env.GRANTTAP_GROK_BIN = fixture.bin;
  t.after(() => {
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    delete process.env.GRANTTAP_GROK_BIN;
  });

  const { startSessionMonitor } = await import("../apps/bridge/src/monitor");
  saveRuntimeConfig({
    meshEnabled: false,
    providerSettings: { claude: true, codex: true, cursor: true, grok: true },
  });
  const fake = new FakeRelay();
  const monitor = startSessionMonitor(fake as never);
  t.after(() => monitor.close());

  // The phone opens a chat it has never subscribed to. This is the moment the
  // transcript is actually needed, and it must not wait for the 30s tick.
  assert.equal(await fake.emit({
    type: "session.subscribe", sessionId: "grok-open", active: true, createdAt: Date.now(),
  }), true);

  assert.equal(
    await waitForActivity(fake, "grok-open"),
    true,
    "the first subscribe must publish the transcript, not just the catalog",
  );
});
