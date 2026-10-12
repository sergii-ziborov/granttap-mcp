import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type { SessionInfo, SessionsStatus } from "../../../../../packages/protocol/schema";
import { nativeTranscriptSource, restoreNativeTranscriptSource } from "../../sessions";
import { publishedCatalog, publishedSession, rememberPublishedCatalog, resumePublishedChats } from "..";

function environment(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-catalog-cache-"));
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CODEX_SESSIONS_DIR"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const [index, name] of names.entries()) {
    process.env[name] = join(root, ["config", "claude", "codex"][index]!);
    mkdirSync(process.env[name]!, { recursive: true });
  }
  t.after(() => { for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  } });
  return { root, file: join(root, "config", "session-catalog-cache.json") };
}

const client = (room = "same-room") => ({ room }) as RelayClient;
function session(id: string, agent: SessionInfo["agent"] = "claude"): SessionInfo {
  return { sessionId: id, agent, state: "working", startedAt: 1, lastActivityAt: 2,
    tokensSession: 0, tokensLastTurn: 0 };
}
function status(sessions: SessionInfo[], history: SessionInfo[] = []): SessionsStatus {
  return { type: "sessions.status", machine: "Mac", sessions, history, generatedAt: 3 };
}

test("known identity survives process restart without storing titles or tool descriptions", t => {
  const { root, file } = environment(t);
  const chat = session("saved-chat");
  const path = join(root, "claude", `${chat.sessionId}.jsonl`); writeFileSync(path, "{}\n");
  assert.equal(restoreNativeTranscriptSource(chat, path), true);
  chat.title = "private title text";
  chat.mcpServers = [{ name: "test", configuredEnabled: true, allowed: true,
    title: "private descriptor" }];
  const first = client(); rememberPublishedCatalog(first, status([chat], [session("historical")]));
  assert.equal(publishedSession(first, chat.sessionId)?.sessionId, chat.sessionId);
  assert.equal(publishedSession(first, chat.sessionId)?.title, chat.title,
    "live identity reads retain the complete current presentation");
  const restored = publishedCatalog(client());
  assert.equal(restored?.generatedAt, 3, "a restored catalog retains its original timestamp");
  assert.equal(publishedSession(client(), "historical")?.sessionId, "historical");
  assert.equal(publishedSession(client(), "unknown"), undefined);
  assert.equal(nativeTranscriptSource(chat), path);
  const raw = readFileSync(file, "utf8");
  assert.equal(raw.includes("private title text"), false);
  assert.equal(raw.includes("private descriptor"), false);
});

test("a different room or provider root cannot reuse a private native catalog", t => {
  environment(t);
  rememberPublishedCatalog(client(), status([session("scoped")]));
  assert.equal(publishedCatalog(client("other-room")), undefined);
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR += "-changed";
  assert.equal(publishedCatalog(client()), undefined);
});

test("missing malformed oversized and invalid records fall back to discovery", t => {
  const { file } = environment(t);
  assert.equal(publishedCatalog(client()), undefined);
  writeFileSync(file, "not json"); assert.equal(publishedCatalog(client()), undefined);
  writeFileSync(file, "x".repeat(1024 * 1024 + 1));
  assert.equal(publishedCatalog(client()), undefined);
  rememberPublishedCatalog(client(), status([]));
  const stored = JSON.parse(readFileSync(file, "utf8")); stored.status = { type: "sessions.status" };
  writeFileSync(file, JSON.stringify(stored)); assert.equal(publishedCatalog(client()), undefined);
});

test("a full disk leaves the current in-memory catalog readable", t => {
  const { file } = environment(t);
  mkdirSync(file);
  const relay = client(); rememberPublishedCatalog(relay, status([session("in-memory")]));
  assert.equal(publishedSession(relay, "in-memory")?.sessionId, "in-memory");
});

test("startup sends every saved primary chat head before discovery and preserves history separately", async t => {
  environment(t);
  const relay = client();
  rememberPublishedCatalog(relay, status([session("first"), session("second", "codex"),
    session("beta", "grok")], [session("old")]));
  const sent: string[] = [];
  await resumePublishedChats(relay, async (chat, saved) => {
    assert.equal(saved.generatedAt, 3);
    sent.push(chat.sessionId);
    if (chat.sessionId === "first") throw new Error("transient send failure");
  });
  assert.deepEqual(sent, ["first", "second"]);
  const none: string[] = [];
  await resumePublishedChats(client("no-cache"), async chat => { none.push(chat.sessionId); });
  assert.deepEqual(none, []);
});

test("native locations must match the provider identity and stay within its real root", t => {
  const { root } = environment(t);
  const claude = session("claude-native"), codex = session("codex-native", "codex");
  const path = join(root, "codex", "rollout-date-codex-native.jsonl");
  writeFileSync(path, "{}\n");
  assert.equal(restoreNativeTranscriptSource(codex, path), true);
  assert.equal(nativeTranscriptSource(codex), path);
  assert.equal(restoreNativeTranscriptSource(claude, path), false);
  assert.equal(restoreNativeTranscriptSource(session("bad/id"), path), false);
  assert.equal(restoreNativeTranscriptSource(session("unsupported", "grok"), path), false);
  assert.equal(nativeTranscriptSource(session("unsupported", "grok")), undefined);
  assert.equal(restoreNativeTranscriptSource(codex, join(root, "codex", "missing-codex-native.jsonl")), false);
  const missing = join(root, "claude", "missing.jsonl");
  assert.equal(restoreNativeTranscriptSource(session("missing"), missing), false);
  const outside = join(root, "outside", "escape.jsonl");
  mkdirSync(join(root, "outside")); writeFileSync(outside, "{}\n");
  assert.equal(restoreNativeTranscriptSource(session("escape"), outside), false);
  symlinkSync(outside, join(root, "claude", "escape.jsonl"));
  assert.equal(restoreNativeTranscriptSource(session("escape"), join(root, "claude", "escape.jsonl")), false);
});
