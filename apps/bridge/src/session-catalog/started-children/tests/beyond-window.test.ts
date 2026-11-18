import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { scanSessionHistory, scanSessionHistoryForPaging, scanSessions } from "../../../sessions";
import { MAX_FILES } from "../../../sessions/support/common";
import { startedByLink } from "../../../started-by";
import { AT, ONE_REQUEST, lessonartRows, writeCodexRun, writeTranscript } from "../../../started-by/folders/tests/lessonart";
import { countedRuns, settleRunsBeyondWindow } from "..";
import { forgetBeyondWindow } from "../beyond-window";

const PARENT = { agent: "claude" as const, sessionId: "38034755-03a1-429d-8db6-2aa351e64a0b" };
/** More runs than the catalog's window reads, as one chat's script started them. */
const RUNS = MAX_FILES + 30;

function roots(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-beyond-window-"));
  const names = ["GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CODEX_SESSIONS_DIR", "GRANTTAP_CONFIG_DIR"] as const;
  const previous = names.map((name) => process.env[name]);
  const paths = { claude: join(root, "claude", "-Users-me-dev-lessons"), codex: join(root, "codex"), config: join(root, "config"),
    folder: join(root, "lessonart") };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = join(root, "claude");
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = paths.codex;
  process.env.GRANTTAP_CONFIG_DIR = paths.config;
  forgetBeyondWindow();
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    });
    forgetBeyondWindow();
    rmSync(root, { recursive: true, force: true });
  });
  return paths;
}

const runId = (index: number) => `019a8c${String(index).padStart(2, "0").slice(-2)}-0000-7000-8000-${String(index).padStart(12, "0")}`;

/** The course chat's script: `RUNS` picture runs, the first 60 with a picture, the last 150 refused by the usage limit. */
function course(t: TestContext) {
  const paths = roots(t);
  const start = Date.now() - 20 * 60 * 60_000;
  writeTranscript(join(paths.claude, `${PARENT.sessionId}.jsonl`), lessonartRows(paths.folder, start, PARENT.sessionId));
  for (let index = 0; index < RUNS; index += 1) {
    const at = start + AT.detached + 5_000 + index * 2_000;
    writeCodexRun(paths.codex, { id: runId(index), at, cwd: paths.folder, seconds: 1,
      request: `${ONE_REQUEST} ${paths.folder}/png/u${index}.png. Prompt: lesson ${index}. Do not write code.` });
  }
  return { paths, start };
}

test("runs the catalog's window no longer reads are linked to the chat that started them and counted on it", async (t) => {
  const { paths } = course(t);
  // The window holds the newest 200 runs: before the pass, the parent counts only those.
  const before = scanSessionHistory().find((session) => session.sessionId === PARENT.sessionId);
  assert.equal(before?.startedChildren?.finished, MAX_FILES);
  assert.equal(startedByLink({ agent: "codex", sessionId: runId(0) }), undefined, "the oldest run is past the window");

  assert.equal(await settleRunsBeyondWindow({ force: true }), RUNS - MAX_FILES);
  assert.deepEqual(startedByLink({ agent: "codex", sessionId: runId(0) })?.parent, PARENT);
  assert.equal(countedRuns().of(PARENT).size, RUNS);
  const parent = scanSessionHistory().find((session) => session.sessionId === PARENT.sessionId);
  assert.equal(parent?.startedChildren?.finished, RUNS, "every run, not only the window's");
  assert.equal(scanSessions().sessions.filter((session) => session.startedBy).length <= 3, true, "still three rows at most");
  // A page of history names the same counts on the parent.
  assert.equal(scanSessionHistoryForPaging().sessions.find((session) => session.sessionId === PARENT.sessionId)
    ?.startedChildren?.finished, RUNS);
  const stored = readFileSync(join(paths.config, "started-runs.json"), "utf8");
  assert.equal(stored.includes("lessonart") || stored.includes("image_gen"), false, "ids and outcomes only");

  // Written down: the next pass reads nothing and changes nothing, even when forced.
  assert.equal(await settleRunsBeyondWindow({ force: true }), 0);
  // Within a minute a pass does not run at all.
  assert.equal(await settleRunsBeyondWindow(), 0);
});

test("a run past two days, a person's own chat and a run in another folder are not linked by the pass", async (t) => {
  const { paths, start } = course(t);
  const stale = "019a8b00-0000-7000-8000-0000000stale";
  const typed = "019a8b01-0000-7000-8000-0000000typed";
  const elsewhere = "019a8b02-0000-7000-8000-00000elsewhere";
  writeCodexRun(paths.codex, { id: typed, at: start + AT.detached + 6_000, cwd: paths.folder, headless: false,
    request: "Look at the pictures in this folder and tell me which are weak" });
  writeCodexRun(paths.codex, { id: elsewhere, at: start + AT.detached + 6_500, cwd: join(paths.folder, "..", "elsewhere"),
    request: `${ONE_REQUEST} somewhere else. Do not write code.` });
  writeCodexRun(paths.codex, { id: stale, at: start + AT.detached + 7_000, cwd: paths.folder, request: `${ONE_REQUEST} again.` });
  const day = join(paths.codex, ...new Date(start + AT.detached + 7_000).toISOString().slice(0, 10).split("-"));
  const old = (Date.now() - 3 * 24 * 60 * 60_000) / 1_000;
  for (const name of readdirSync(day)) {
    if (name.includes(stale)) utimesSync(join(day, name), old, old);
  }
  scanSessions();
  await settleRunsBeyondWindow({ force: true });
  for (const id of [stale, typed, elsewhere]) assert.equal(startedByLink({ agent: "codex", sessionId: id }), undefined, id);
  assert.equal(countedRuns().of(PARENT).size, RUNS);
});

test("with no chat read that ran commands, the pass reads nothing", async (t) => {
  roots(t);
  assert.equal(await settleRunsBeyondWindow({ force: true }), 0);
});
