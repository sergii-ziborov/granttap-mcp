import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  forgetFrozenRuns, freezeSurvivingRuns, liveRunCounts, registerRunContinuation, survivableKey, thawSurvivingRuns,
  withSurvivor, type SurvivorHandle,
} from "..";
import { blockingDeliveries, isDeliveryInFlight, queued } from "../../in-flight";
import { abortProcesses, runProcess, STOPPED_ERROR, yieldRun } from "../../process";
import type { ReplyResult } from "../../payload/types";
import { adoptSurvivingRuns, adoptedRunsSettling } from "../adoption";
import { openRunFiles } from "../files";
import { makeRunFolder, processStartToken, readRunRecord, runFolder, runRecords, runsRoot, writeRunRecord, type RunRecord } from "../records";

/** A Grok stand-in: says it took the prompt, then answers once `finish` exists in its folder. */
const PROVIDER = `const fs = require("node:fs"), path = require("node:path");
process.stdout.write(JSON.stringify({ type: "text", data: "Working on it" }) + "\\n");
const finish = path.join(process.argv[1], "finish");
const timer = setInterval(() => {
  if (!fs.existsSync(finish)) return;
  clearInterval(timer);
  process.stdout.write(JSON.stringify({ type: "result", result: "Adopted answer" }) + "\\n");
}, 20);`;

async function until(check: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), what);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-run-survival-"));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const sent: Array<{ data: unknown; result: ReplyResult }> = [];
  registerRunContinuation("test-reply", async (data, result) => { sent.push({ data, result }); });
  const stops: Array<() => void> = [];
  t.after(async () => {
    for (const stop of stops) stop();
    forgetFrozenRuns();
    await until(() => !adoptedRunsSettling(), "answers sent");
    if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const gone = (() => { const child = spawnSync(process.execPath, ["-e", ""]); return child.pid!; })();
  /** A run a monitor that has exited started: its provider is detached and writes to the run's own files. */
  const leftRunning = (key: string, extra: Partial<RunRecord> = {}) => {
    const runId = randomUUID(), folder = makeRunFolder(runId), files = openRunFiles(folder);
    const child = spawn(process.execPath, ["-e", PROVIDER, folder], { stdio: files.stdio, detached: true });
    files.release();
    child.unref();
    const record: RunRecord = { version: 1, runId, pid: child.pid!, startToken: processStartToken(child.pid!),
      ownerPid: gone, key, command: process.execPath, parser: { kind: "grok", sessionId: key }, startedAt: Date.now(),
      deadline: Date.now() + 600_000, admitted: true, late: true,
      continuation: { kind: "test-reply", data: { chat: key } }, ...extra };
    writeRunRecord(record);
    return { record, folder, finish: () => writeFileSync(join(folder, "finish"), "") };
  };
  const adopt = () => {
    const lines: string[] = [];
    stops.push(adoptSurvivingRuns({ connected: () => true, pollMs: 25, rescanMs: 50, log: line => { lines.push(line); } }));
    return lines;
  };
  return { root, sent, gone, leftRunning, adopt };
}

test("a run the previous monitor left running is taken over: it holds its chat, and its answer is sent once", async t => {
  const f = fixture(t), run = f.leftRunning("chat-left-running");
  const lines = f.adopt();
  await until(() => isDeliveryInFlight("chat-left-running"), "the chat is busy with its run");
  assert.match(lines[0] ?? "", /^Taking over a run the previous monitor started \d+ min ago\.$/);
  assert.equal(survivableKey("chat-left-running"), true, "a further update could hand it over again");
  assert.equal(blockingDeliveries().some(item => item.key === "chat-left-running"), false);
  assert.equal(liveRunCounts().survivable >= 1, true);
  const order: string[] = [];
  const next = queued("chat-left-running", async () => { order.push("next message"); return { ok: true, text: "next" }; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(order, [], "the chat's next message waits for the run it took over");
  run.finish();
  await until(() => f.sent.length === 1, "the answer is sent");
  assert.deepEqual(f.sent[0], { data: { chat: "chat-left-running" },
    result: { ok: true, text: "Adopted answer", sessionId: "chat-left-running" } });
  await next;
  assert.deepEqual(order, ["next message"]);
  await until(() => !existsSync(runFolder(run.record.runId)), "the run's folder goes once its answer is sent");
  assert.ok(lines.some(line => line === "A run this monitor took over has ended."));
});

test("a run that ended while no monitor ran is delivered, and one cut off mid-turn says so", async t => {
  const f = fixture(t);
  const finished = f.leftRunning("chat-finished");
  finished.finish();
  const cut = f.leftRunning("chat-cut-off");
  await until(() => readRunOutput(finished.folder).includes("Adopted answer"), "the first answers before any monitor looks");
  for (const run of [finished, cut]) kill(run.record.pid);
  await until(() => !alive(finished.record.pid) && !alive(cut.record.pid), "both processes are gone");
  f.adopt();
  await until(() => f.sent.length === 2, "both outcomes are sent");
  const by = new Map(f.sent.map(item => [(item.data as { chat: string }).chat, item.result]));
  assert.deepEqual(by.get("chat-finished"), { ok: true, text: "Adopted answer", sessionId: "chat-finished" },
    "the provider reported the end of its turn");
  assert.equal(by.get("chat-cut-off")?.ok, false);
  assert.match((by.get("chat-cut-off") as { error: string }).error, /^Grok Build stopped before it finished this turn/);
  assert.deepEqual(runRecords(), []);
});

test("a pause from the phone stops a run that was taken over, and its deadline still applies", async t => {
  const f = fixture(t);
  const paused = f.leftRunning("chat-paused");
  const late = f.leftRunning("chat-overdue", { deadline: Date.now() + 300 });
  f.adopt();
  await until(() => isDeliveryInFlight("chat-paused"), "taken over");
  assert.equal(abortProcesses("chat-paused"), 1);
  await until(() => f.sent.length === 2, "both end");
  const by = new Map(f.sent.map(item => [(item.data as { chat: string }).chat, item.result]));
  assert.deepEqual(by.get("chat-paused"), { ok: false, error: STOPPED_ERROR });
  assert.match((by.get("chat-overdue") as { error: string }).error, /did not respond within 0s\.$/);
  await until(() => !alive(paused.record.pid) && !alive(late.record.pid), "both processes were stopped");
});

test("a run taken over and stopped for a waiting message ends without an answer of its own", async t => {
  const f = fixture(t);
  const run = f.leftRunning("chat-yielded");
  f.adopt();
  await until(() => isDeliveryInFlight("chat-yielded"), "taken over");
  assert.equal(yieldRun(["chat-yielded"], "chat-yielded"), 1);
  await until(() => f.sent.length === 1, "it ends");
  assert.deepEqual(f.sent[0]?.result, { ok: true, text: "", sessionId: "chat-yielded", delivery: "native" },
    "its turn's answer is already in the chat's history, and it is not reported as stopped from the phone");
  await until(() => !alive(run.record.pid), "the process was stopped");
});

test("a run whose monitor is still running is left to it", async t => {
  const f = fixture(t);
  const run = f.leftRunning("chat-of-a-live-monitor", { ownerPid: process.pid, ownerStartToken: processStartToken(process.pid) });
  const other = f.leftRunning("chat-of-another-monitor", { ownerPid: process.ppid, ownerStartToken: processStartToken(process.ppid) });
  f.adopt();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(isDeliveryInFlight("chat-of-a-live-monitor"), false);
  assert.equal(isDeliveryInFlight("chat-of-another-monitor"), false);
  for (const item of [run, other]) kill(item.record.pid);
  assert.equal(readRunRecord(run.record.runId)?.key, "chat-of-a-live-monitor", "its record stays for its monitor");
});

test("a run that ends while its monitor is being replaced leaves its answer for the next one", async t => {
  const f = fixture(t);
  const folder = mkdtempSync(join(f.root, "provider-"));
  const handle: SurvivorHandle = { continuation: { kind: "test-reply", data: { chat: "chat-frozen" } }, late: true };
  const started = withSurvivor(handle, () => queued("chat-frozen", () => runProcess(process.execPath, ["-e", PROVIDER, folder],
    undefined, 60_000, () => ({ ok: true, text: "parsed here" }), undefined, "chat-frozen", undefined,
    { parser: { kind: "grok", sessionId: "chat-frozen" } })));
  await until(() => handle.adoptable?.() === true, "the run can be handed over once it took the prompt");
  freezeSurvivingRuns();
  writeFileSync(join(folder, "finish"), "");
  assert.deepEqual(await started, { ok: true, text: "", delivery: "handed-over" }, "this monitor sends nothing for it");
  assert.equal(runRecords().length, 1, "the answer waits on disk");
  assert.equal(f.sent.length, 0);
  thawSurvivingRuns();
  await until(() => f.sent.length === 1, "the replacement did not come, so this monitor sends it after all");
  assert.deepEqual(f.sent[0]!.result, { ok: true, text: "Adopted answer", sessionId: "chat-frozen" });
  assert.deepEqual(runRecords(), []);
  assert.equal(runsRoot().startsWith(f.root), true);
});

test("a Claude run cut off without its answer, whose turn the chat shows answered, is not reported as stopped", async t => {
  const f = fixture(t);
  const projects = mkdtempSync(join(f.root, "claude-projects-"));
  const prior = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = projects;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR; else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = prior; });
  mkdirSync(join(projects, "-work-app"), { recursive: true });
  const startedAt = Date.now() - 60_000;
  const row = (sessionId: string, at: number, stop: string) => JSON.stringify({ type: "assistant", sessionId,
    timestamp: new Date(at).toISOString(), message: { role: "assistant", stop_reason: stop, content: [] } });
  writeFileSync(join(projects, "-work-app", "chat-claude-answered.jsonl"),
    [row("chat-claude-answered", startedAt - 600_000, "end_turn"), row("chat-claude-answered", startedAt + 30_000, "end_turn")].join("\n") + "\n");
  writeFileSync(join(projects, "-work-app", "chat-claude-cut.jsonl"),
    [row("chat-claude-cut", startedAt - 600_000, "end_turn"), row("chat-claude-cut", startedAt + 30_000, "tool_use")].join("\n") + "\n");
  // `claude -p` prints its answer only as it exits: a full disk or an unseen exit left none.
  const answered = f.leftRunning("chat-claude-answered", { parser: { kind: "claude" }, startedAt });
  const cut = f.leftRunning("chat-claude-cut", { parser: { kind: "claude" }, startedAt });
  for (const run of [answered, cut]) kill(run.record.pid);
  await until(() => !alive(answered.record.pid) && !alive(cut.record.pid), "both processes are gone");
  f.adopt();
  await until(() => f.sent.length === 2, "both outcomes are sent");
  const by = new Map(f.sent.map(item => [(item.data as { chat: string }).chat, item.result]));
  assert.deepEqual(by.get("chat-claude-answered"), { ok: true, text: "", sessionId: "chat-claude-answered", delivery: "native" },
    "the answer is in the chat; the phone is not told the turn broke off");
  assert.match((by.get("chat-claude-cut") as { error: string }).error, /^Claude Code stopped before it finished this turn/,
    "a turn the chat shows unfinished is still reported as cut off");
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readRunOutput(folder: string): string {
  try { return readFileSync(join(folder, "stdout"), "utf8"); } catch { return ""; }
}

function kill(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
}
