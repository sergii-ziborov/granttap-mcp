import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionInfo, SessionsStatus } from "../../../../../packages/protocol/schema";
import { scanSessionHistory, scanSessions } from "../../sessions";
import { rememberStartedLinks, rememberStartedRuns, startedByPath, startedByState } from "../links";

const PARENT = "5b0e6c1e-parent-0000-0000-000000000001";
const PROMPT = "Use your image_gen tool to generate one editorial illustration for a blog article about a job search.";
const FOLDER = "/tmp/granttap-blogart-fixture";

function roots(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-started-publish-"));
  const names = ["GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CODEX_SESSIONS_DIR", "GRANTTAP_CONFIG_DIR"] as const;
  const previous = names.map((name) => process.env[name]);
  const paths = { claude: join(root, "claude", "-Users-me-dev-app"), codex: join(root, "codex"), config: join(root, "config") };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = join(root, "claude");
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = paths.codex;
  process.env.GRANTTAP_CONFIG_DIR = paths.config;
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    });
    rmSync(root, { recursive: true, force: true });
  });
  return paths;
}

const iso = (at: number) => new Date(at).toISOString();
const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** A chat a person typed in, which ran `codex exec` once from its shell. */
function claudeParent(root: string, at: number, command = `cd ${FOLDER} && codex exec "${PROMPT}"`): void {
  const base = { sessionId: PARENT, cwd: "/Users/me/dev/app", entrypoint: "cli" };
  writeFileSync(join(root, `${PARENT}.jsonl`), lines([
    { ...base, type: "user", timestamp: iso(at), message: { role: "user", content: "Write three articles and illustrate them" } },
    { ...base, type: "assistant", timestamp: iso(at + 1_000), message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_codex", name: "Bash", input: { command } }] } },
    { ...base, type: "user", timestamp: iso(at + 60_000), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_codex", content: "saved" }] } },
    { ...base, type: "assistant", timestamp: iso(at + 61_000), message: { role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "Done" }] } },
  ]));
}

function codexChild(root: string, id: string, at: number, input: { prompt?: string; headless?: boolean; cwd?: string } = {}): void {
  const day = join(root, ...iso(at).slice(0, 10).split("-"));
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-${iso(at).slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`), lines([
    { type: "session_meta", timestamp: iso(at), payload: { id, timestamp: iso(at), cwd: input.cwd ?? FOLDER,
      ...(input.headless === false ? { originator: "codex_cli_rs", source: "cli" } : { originator: "codex_exec", source: "exec" }) } },
    { type: "response_item", timestamp: iso(at + 500), payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>" },
      { type: "input_text", text: input.prompt ?? PROMPT }] } },
    { type: "response_item", timestamp: iso(at + 20_000), payload: { type: "message", role: "assistant", content: [
      { type: "output_text", text: "Saved the picture." }] } },
    { type: "event_msg", timestamp: iso(at + 20_100), payload: { type: "task_complete" } },
  ]));
}

const CHILD = "01a1e72d-3cd3-7ea0-854d-252ca5443461";

test("a chat another chat ran headless names it as startedBy, and the link outlives the transcript", (t) => {
  const paths = roots(t);
  const at = Date.now() - 30 * 60_000;
  claudeParent(paths.claude, at);
  codexChild(paths.codex, CHILD, at + 2_000);
  codexChild(paths.codex, "01a1e72d-0000-7000-8000-typedbyaperson", at + 3_000, { headless: false });
  for (const sessions of [scanSessions().sessions, scanSessionHistory()]) {
    const child = sessions.find((session) => session.sessionId === CHILD);
    assert.deepEqual(child?.startedBy, { agent: "claude", sessionId: PARENT }, "the child is still a chat of its own");
    assert.equal(sessions.find((session) => session.sessionId === PARENT)?.startedBy, undefined);
    assert.equal(sessions.find((session) => session.agent === "codex" && session.sessionId !== CHILD)?.startedBy, undefined,
      "a session a person started at a terminal is nobody's child");
    assert.equal(sessions.find((session) => session.sessionId === PARENT)?.childThreads, undefined,
      "only helper runs become nested conversations");
  }
  const status = SessionsStatus.parse({ type: "sessions.status", machine: "Mac", sessions: scanSessions().sessions, generatedAt: Date.now() });
  assert.deepEqual(status.sessions.find((session) => session.sessionId === CHILD)?.startedBy, { agent: "claude", sessionId: PARENT },
    "the published record carries it");
  const stored = JSON.parse(readFileSync(startedByPath(), "utf8"));
  assert.deepEqual(stored.links.map((link: any) => [link.agent, link.sessionId, link.parent.sessionId, link.source]),
    [["codex", CHILD, PARENT, "transcript"]], "only ids, providers and how it was learned are kept");
  assert.equal(JSON.stringify(stored).includes("image_gen"), false, "no request text is written down");

  // The parent's transcript is gone from this computer: the child still names it.
  rmSync(join(paths.claude, `${PARENT}.jsonl`));
  assert.deepEqual(scanSessions().sessions.find((session) => session.sessionId === CHILD)?.startedBy, { agent: "claude", sessionId: PARENT });
});

test("a captured run names its child by folder and start time, even when the parent is not on this computer", (t) => {
  const paths = roots(t);
  const at = Date.now() - 20 * 60_000;
  const remote = "codex-thread-on-another-mac-01";
  codexChild(paths.codex, CHILD, at, { prompt: "Draw a lighthouse." });
  codexChild(paths.codex, "01a1e72d-1111-7000-8000-000000000002", at + 400_000, { prompt: "Draw another lighthouse." });
  rememberStartedRuns([
    { agent: "codex", pid: 4242, startedAt: at - 900, folder: `/private${FOLDER}`, parent: { agent: "codex", sessionId: remote }, capturedAt: at },
    { agent: "claude", pid: 4243, startedAt: at - 900, folder: FOLDER, parent: { agent: "codex", sessionId: remote }, capturedAt: at },
  ]);
  const sessions = scanSessions().sessions;
  assert.deepEqual(sessions.find((session) => session.sessionId === CHILD)?.startedBy, { agent: "codex", sessionId: remote });
  assert.equal(sessions.find((session) => session.sessionId !== CHILD)?.startedBy, undefined,
    "a run is one session: a later one in the same folder is not its child");
  const state = startedByState();
  assert.deepEqual([...state.links.values()].map((link) => [link.sessionId, link.source]), [[CHILD, "process"]]);
  assert.deepEqual(state.runs.map((run) => run.pid), [4243], "the joined run is let go; the other provider's waits for its session");
});

test("a link its own process named replaces one read from a transcript, and the first such link stands", (t) => {
  roots(t);
  const child = { agent: "codex" as const, sessionId: CHILD };
  const at = Date.now();
  assert.equal(rememberStartedLinks([{ ...child, parent: { agent: "claude", sessionId: PARENT }, source: "transcript", at }]), 1);
  assert.equal(rememberStartedLinks([{ ...child, parent: { agent: "claude", sessionId: "another-chat-0001" }, source: "transcript", at }]), 0);
  assert.equal(rememberStartedLinks([{ ...child, parent: { agent: "claude", sessionId: "the-real-parent-01" }, source: "process", at }]), 1);
  assert.equal(rememberStartedLinks([{ ...child, parent: { agent: "claude", sessionId: "a-later-claim-0001" }, source: "process", at }]), 0);
  assert.equal(startedByState().links.get(`codex\0${CHILD}`)?.parent.sessionId, "the-real-parent-01");
  assert.equal(rememberStartedLinks([{ ...child, parent: child, source: "process", at }]), 0, "never its own parent");
  writeFileSync(startedByPath(), "{not json");
  assert.equal(startedByState().links.size, 0, "a damaged file holds nothing and is rewritten by the next link");
});

test("startedBy is strict on the wire", () => {
  const base = { sessionId: CHILD, agent: "codex", state: "idle", startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 };
  assert.deepEqual(SessionInfo.parse({ ...base, startedBy: { agent: "claude", sessionId: PARENT } }).startedBy,
    { agent: "claude", sessionId: PARENT });
  for (const startedBy of [
    { agent: "claude", sessionId: PARENT, title: "extra" },
    { agent: "gemini", sessionId: PARENT },
    { agent: "claude", sessionId: "short" },
    { agent: "claude", sessionId: "has spaces in it" },
    { agent: "claude" },
  ]) {
    assert.equal(SessionInfo.safeParse({ ...base, startedBy }).success, false, JSON.stringify(startedBy));
  }
  assert.equal(SessionInfo.parse(base).startedBy, undefined);
});
