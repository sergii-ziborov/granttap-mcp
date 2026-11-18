import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApprovalRequest, SessionInfo } from "../../../../../packages/protocol/schema";
import { restoreNativeTranscriptSource } from "../../sessions/native-source";
import { liveMapObserver } from "..";

const ENV = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
  "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_GROK_BIN"] as const;

function isolate(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "granttap-live-map-observe-"));
  const previous = ENV.map(name => [name, process.env[name]] as const);
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = join(root, "claude");
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = join(root, "codex");
  process.env.GRANTTAP_GROK_SESSIONS_DIR = join(root, "grok");
  t.after(() => { for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  return root;
}

const row = (seconds: number, value: Record<string, unknown>) =>
  `${JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 18, 12, 0, seconds)).toISOString(), ...value })}\n`;
const toolUse = (seconds: number, id: string, name: string) => row(seconds, { type: "assistant",
  message: { id: `m-${id}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input: {} }] } });
const session = (agent: string, sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId, agent, state: "working", startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0, ...extra });

test("a Claude chat is read from its own file and its recent subagents, again only when they change", (t) => {
  const root = isolate(t);
  const project = join(root, "claude", "-repo");
  mkdirSync(join(project, "live-claude", "subagents"), { recursive: true });
  const file = join(project, "live-claude.jsonl");
  writeFileSync(file, toolUse(1, "t1", "Agent"));
  // A whole second, so that putting it back gives the very same revision.
  const second = Math.floor(Date.now() / 1_000) - 5;
  utimesSync(file, second, second);
  writeFileSync(join(project, "live-claude", "subagents", "agent-k1.jsonl"), toolUse(2, "c1", "WebSearch"));
  const pending: ApprovalRequest[] = [];
  const observe = liveMapObserver({ pending: () => pending, now: () => 5_000 });
  const chat = session("claude", "live-claude", { childThreads: [{ threadId: "th1", parentThreadId: "live-claude",
    depth: 1, state: "working", startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 }] });
  const first = observe(chat);
  assert.deepEqual(first.calls.filter(call => !call.mark).map(call => [call.station, call.agentKey]),
    [["agents", undefined], ["web", "agent-k1"]]);
  assert.deepEqual(first.agents, ["t1", "th1"]);

  writeFileSync(file, `${"x".repeat(statSync(file).size - 1)}\n`);
  utimesSync(file, second, second);
  assert.equal(observe(chat).calls.length, first.calls.length, "an unchanged revision is not read again");
  appendFileSync(file, toolUse(3, "t2", "Read"));
  assert.ok(observe(chat).calls.some(call => call.key === "t2"));

  pending.push({ type: "approval.request", requestId: "r1", agent: "claude", kind: "permission", tool: "Bash",
    title: "Run", sessionId: "live-claude", risk: "medium", createdAt: 4_000 });
  const asked = observe(chat).calls.find(call => call.station === "hooks");
  assert.deepEqual([asked?.status, asked?.mark, asked?.name], ["run", "approval", "Bash"]);
  pending.length = 0;
  const answered = observe(chat).calls.find(call => call.station === "hooks");
  assert.deepEqual([answered?.status, answered?.endedAt], ["ok", 5_000]);
});

test("a Codex rollout is found where discovery put it", (t) => {
  const root = isolate(t);
  const folder = join(root, "codex", "2026", "11", "18");
  mkdirSync(folder, { recursive: true });
  const id = "019a0000-0000-7000-8000-00000000c0de";
  const path = join(folder, `rollout-2026-11-18T12-00-00-${id}.jsonl`);
  writeFileSync(path, row(1, { type: "response_item", payload: { type: "function_call", name: "exec_command",
    call_id: "c1", arguments: "{\"cmd\":\"gh pr list\"}" } }));
  assert.equal(restoreNativeTranscriptSource({ agent: "codex", sessionId: id }, path), true);
  const observation = liveMapObserver({ pending: () => [] })(session("codex", id));
  assert.deepEqual(observation.calls.map(call => [call.station, call.status]), [["web", "run"]]);
});

test("Grok, and chats with nothing to read, give what they can", (t) => {
  const root = isolate(t);
  const repo = join(root, "repo");
  const folder = join(root, "grok", "project", "grok-live");
  mkdirSync(repo, { recursive: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "summary.json"), JSON.stringify({ info: { id: "grok-live", cwd: repo },
    generated_title: "Live", created_at: Date.now() - 2_000, updated_at: Date.now(), current_model_id: "grok-build" }));
  writeFileSync(join(folder, "chat_history.jsonl"), `${JSON.stringify({ role: "user", timestamp: Date.now(), content: "Hi" })}\n`);
  const bin = join(root, "grok-fixture");
  writeFileSync(bin, "#!/usr/bin/env node\n", { mode: 0o755 });
  process.env.GRANTTAP_GROK_BIN = bin;
  const observe = liveMapObserver({ pending: () => [] });
  const grok = observe(session("grok", "grok-live", { cwd: repo, model: "grok-build" }));
  assert.equal(grok.calls.some(call => call.mark === "message"), true);
  assert.equal(grok.model, "grok-build");
  assert.deepEqual(observe(session("gemini", "nope")).calls, []);
  assert.deepEqual(observe(session("claude", "never-written")).calls, []);
});
