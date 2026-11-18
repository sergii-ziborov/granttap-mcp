import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { compactStartedChildren, countedRun, countedRuns, countStartedChildren, countStartedRuns, recordStartedChildren,
  startedRunsPath } from "..";
import { MAX_COUNTED_RUNS } from "../ledger";

const PARENT = { agent: "claude" as const, sessionId: "38034755-03a1-429d-8db6-2aa351e64a0b" };
const OTHER = { agent: "codex" as const, sessionId: "019a8c01-0000-7000-8000-000000000other" };
const now = Date.now();

function isolated(t: TestContext): string {
  const config = mkdtempSync(join(tmpdir(), "granttap-started-runs-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = config;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(config, { recursive: true, force: true });
  });
  return config;
}

const row = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId, agent: "codex", cwd: "/tmp/lessonart",
  title: "Use your image_gen tool to generate one landscape image", state: "idle", startedAt: now - 60_000,
  lastActivityAt: now - 30_000, tokensSession: 0, tokensLastTurn: 0, startedBy: PARENT, ...extra });

test("a finished run is written down once with how it ended, and a working one is not", (t) => {
  isolated(t);
  assert.equal(countedRun(row("019a8c00-0000-7000-8000-00000000work", { state: "working" })), undefined);
  assert.deepEqual(countedRun(row("019a8c00-0000-7000-8000-000000answer")),
    { sessionId: "019a8c00-0000-7000-8000-000000answer", end: "answered", picture: false, at: now - 30_000 });
  const limit = row("019a8c00-0000-7000-8000-0000000limit", { stopped: { reason: "usage_limit", at: now } });
  const rate = row("019a8c00-0000-7000-8000-00000000rate", { stopped: { reason: "rate_limit", at: now } });
  const reset = row("019a8c00-0000-7000-8000-0000000reset", { usageLimit: { resetsAt: now + 1, autoContinue: false } });
  const failed = row("019a8c00-0000-7000-8000-00000failed", { stopped: { reason: "service", at: now } });
  const picture = row("019a8c00-0000-7000-8000-00000picture", { images: [{ id: `helper-image:${"a".repeat(24)}:${"b".repeat(24)}`,
    name: "u1.png", markdown: "/tmp/lessonart/u1.png" }] });
  assert.deepEqual([limit, rate, reset, failed, picture].map((session) => countedRun(session)?.end),
    ["limit", "limit", "limit", "error", "answered"]);
  assert.equal(recordStartedChildren([limit, rate, reset, failed, picture, row("019a8c00-0000-7000-8000-00000orphan",
    { startedBy: undefined })]), 5);
  assert.equal(recordStartedChildren([limit, rate, reset, failed, picture]), 0, "nothing new, nothing written");
  const stored = readFileSync(startedRunsPath(), "utf8");
  assert.equal(stored.includes("lessonart") || stored.includes("image_gen"), false, "no folder or request is written down");
  // The parent listed alone still carries every run it started.
  const [parent] = countStartedChildren([{ ...row(PARENT.sessionId, { startedBy: undefined }), agent: "claude" }]);
  assert.deepEqual(parent?.startedChildren, { finished: 5, stopped: 4, limited: 3, pictures: 1, lastAt: now - 30_000 });
});

test("a run seen again with another outcome, or under another chat, is written down once, where it is now", (t) => {
  isolated(t);
  const id = "019a8c00-0000-7000-8000-0000000moved";
  countStartedRuns([{ parent: PARENT, run: { sessionId: id, end: "limit", picture: false, at: now - 2 } }], now);
  assert.equal(countStartedRuns([{ parent: PARENT, run: { sessionId: id, end: "answered", picture: true, at: now - 1 } }], now), 1);
  assert.deepEqual([...countedRuns().of(PARENT).values()].map((run) => [run.end, run.picture]), [["answered", true]]);
  countStartedRuns([{ parent: OTHER, run: { sessionId: id, end: "answered", picture: true, at: now - 1 } }], now);
  assert.equal(countedRuns().of(PARENT).size, 0);
  assert.equal(countedRuns().of(OTHER).size, 1);
  assert.equal(countStartedRuns([{ parent: PARENT, run: { sessionId: PARENT.sessionId, end: "answered", picture: false, at: now } }], now), 0,
    "a chat never counts itself");
});

test("the oldest runs past six months or past the cap are let go, and an unreadable file counts nothing", (t) => {
  const config = isolated(t);
  const runs = Array.from({ length: MAX_COUNTED_RUNS + 5 }, (_, index) => ({ parent: PARENT,
    run: { sessionId: `019a8c00-0000-7000-8000-${String(index).padStart(12, "0")}`, end: "answered" as const, picture: false,
      at: now - (MAX_COUNTED_RUNS + 5 - index) } }));
  countStartedRuns([...runs, { parent: OTHER, run: { sessionId: "019a8c00-0000-7000-8000-00000ancient", end: "answered",
    picture: false, at: now - 200 * 24 * 60 * 60_000 } }], now);
  const kept = countedRuns().of(PARENT);
  assert.equal(kept.size, MAX_COUNTED_RUNS);
  assert.equal(kept.has(runs[0]!.run.sessionId), false, "the oldest went first");
  assert.equal(countedRuns().of(OTHER).size, 0, "older than six months");
  writeFileSync(join(config, "started-runs.json"), "{ not json");
  assert.equal(countedRuns().has(runs.at(-1)!.run.sessionId), false);
  writeFileSync(join(config, "started-runs.json"), JSON.stringify({ parents: [{ agent: "gemini", sessionId: "x".repeat(12), runs: [] },
    { ...PARENT, runs: [["019a8c00-0000-7000-8000-0000000valid", "lp", now], ["bad id!", "a", now], ["019a8c00-0000-7000-8000-00000nocode", "z", now],
      ["019a8c00-0000-7000-8000-00000000noat", "a", "soon"], [PARENT.sessionId, "a", now], "not a row"] }] }));
  assert.deepEqual([...countedRuns().of(PARENT).values()], [{ sessionId: "019a8c00-0000-7000-8000-0000000valid", end: "limit",
    picture: true, at: now }]);
});

test("the parent keeps its newest three finished runs as rows and counts the written-down ones beyond them", (t) => {
  isolated(t);
  const parent: SessionInfo = { ...row(PARENT.sessionId, { startedBy: undefined }), agent: "claude", state: "working", lastActivityAt: now };
  const listed = Array.from({ length: 5 }, (_, index) => row(`019a8c00-0000-7000-8000-0000000list${index}`,
    { lastActivityAt: now - 10_000 + index, stopped: { reason: "usage_limit", at: now } }));
  const earlier = Array.from({ length: 40 }, (_, index) => ({ parent: PARENT, run: { sessionId: `019a8c00-0000-7000-8000-00000earl${String(index).padStart(3, "0")}`,
    end: index < 30 ? "answered" as const : "error" as const, picture: index < 30, at: now - 3_600_000 + index } }));
  countStartedRuns(earlier, now);
  const after = compactStartedChildren([parent, ...listed]);
  assert.equal(after.length, 1 + 3);
  assert.deepEqual(after[0]?.startedChildren, { finished: 45, stopped: 15, limited: 5, pictures: 30, lastAt: now - 10_000 + 4 });
  // A disk that cannot be written still counts the listed rows.
  process.env.GRANTTAP_CONFIG_DIR = join(startedRunsPath(), "not-a-folder");
  assert.equal(recordStartedChildren(listed), 0);
  assert.equal(compactStartedChildren([parent, ...listed])[0]?.startedChildren?.finished, 5);
});
