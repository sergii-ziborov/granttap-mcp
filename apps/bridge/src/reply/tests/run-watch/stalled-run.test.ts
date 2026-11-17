import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { HOLD_LIMIT_MS, HOLD_RETRY_MS, UpdateDrain } from "../../../runtime-updates/drain";
import { blockingDeliveries, hasBlockingDeliveries, isDeliveryInFlight, oldestBlockingDeliveryStartedAt, queued } from "../../in-flight";
import { abortProcesses, runProcess } from "../../process";
import type { ReplyResult } from "../../payload/types";
import {
  ENDED_GRACE_MS, GONE_GRACE_MS, NO_PROGRESS_MS, parseProcessTable, readProcessTable, SAMPLE_MS, sampleRuns, setRunWatchForTests,
  watchRunProcess, type ProcessRow, type RunWatch,
} from "../../run-watch";
import { withoutSurvivor } from "../../survival";

const never = () => new Promise<ReplyResult>(() => {});
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

/** A clock that starts now, a process table the test writes, and the monitor log. */
function world(t: TestContext) {
  let now = Date.now();
  const processes = new Map<number, { startedAt: number; cpuMs: number; stat: string }>();
  const lines: string[] = [];
  setRunWatchForTests({ now: () => now, log: line => { lines.push(line); },
    rows: async () => [...processes].map(([pid, p]): ProcessRow =>
      ({ pid, pgid: pid, stat: p.stat, cpuMs: p.cpuMs, elapsedMs: now - p.startedAt })) });
  t.after(() => setRunWatchForTests());
  return {
    lines, at: () => now,
    start: (pid: number) => { processes.set(pid, { startedAt: now, cpuMs: 0, stat: "S" }); },
    vanish: (pid: number) => { processes.delete(pid); },
    zombie: (pid: number) => { processes.get(pid)!.stat = "Z"; },
    /** Time passes a minute at a time, the monitor looking at its runs each minute; `busy` ones use processor time. */
    pass: async (ms: number, busy: number[] = []) => {
      for (let left = ms; left > 0; left -= SAMPLE_MS) {
        now += Math.min(SAMPLE_MS, left);
        for (const pid of busy) { const p = processes.get(pid); if (p) p.cpuMs += 2_000; }
        await sampleRuns();
      }
    },
  };
}

/** A key's run that started a watched process and never settles: what a moved Task's hung turn looks like here. */
async function hungRun(key: string, pid: number): Promise<RunWatch> {
  let watch!: RunWatch;
  void withoutSurvivor(() => queued(key, () => { watch = watchRunProcess(pid); return never(); }));
  await settle();
  return watch;
}

const blocking = (key: string) => blockingDeliveries().some(item => item.key === key);

test("a moved Task's turn whose process is gone no longer keeps a runtime update waiting", async t => {
  const w = world(t);
  const key = `transfer-${"53340e5202e8".repeat(4)}`;
  w.start(4242);
  await hungRun(key, 4242);
  const lines: string[] = [];
  const drain = new UpdateDrain({ now: w.at, oldestRun: oldestBlockingDeliveryStartedAt, log: line => { lines.push(line); },
    blockers: () => blockingDeliveries().map(({ key: sessionId, since }) => ({ kind: "run" as const, sessionId, since })) });
  assert.equal(drain.request("0.8.190"), true);
  await w.pass(HOLD_LIMIT_MS, [4242]);
  assert.equal(drain.holding(), false, "the hold gives up while the turn is working");
  assert.match(lines.at(-1)!, /still waits: .*when the runs still going have ended\. It waited for: run in chat transfer/);
  await w.pass(2 * HOLD_RETRY_MS, [4242]);
  assert.equal(drain.request("0.8.190"), false, "a working turn is still waited for");

  // Its provider process goes without this monitor seeing it end: before, the run held the update until its deadline.
  w.vanish(4242);
  await w.pass(SAMPLE_MS);
  await w.pass(GONE_GRACE_MS - SAMPLE_MS);
  assert.equal(blocking(key), true, "a process found gone gets a grace period");
  await w.pass(SAMPLE_MS);
  assert.equal(blocking(key), false);
  assert.equal(blockingDeliveries(undefined, () => undefined).some(item => item.key === key), true,
    "without the watch the run would hold the update until its six-hour deadline");
  assert.equal(hasBlockingDeliveries(), false);
  assert.equal(isDeliveryInFlight(key), true, "the run itself is left alone");
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0]!, /^A runtime update no longer waits for the run in chat transfer-53340e5 that started \d+ min ago: its provider process is gone\.$/);
  assert.equal(drain.request("0.8.190"), true, "the next hold finds nothing to wait for");
  assert.deepEqual(drain.state()?.blockers, []);
  blockingDeliveries();
  assert.equal(w.lines.length, 1, "said once");
});

test("a turn that wrote nothing and used no processor time for half an hour stops holding the update", async t => {
  const w = world(t);
  const key = `transfer-${"a".repeat(48)}`;
  w.start(5001);
  const watch = await hungRun(key, 5001);
  await w.pass(NO_PROGRESS_MS - SAMPLE_MS);
  assert.equal(blocking(key), true);
  watch.output();
  await w.pass(NO_PROGRESS_MS - SAMPLE_MS);
  assert.equal(blocking(key), true, "output counts as work");
  await w.pass(NO_PROGRESS_MS, [5001]);
  assert.equal(blocking(key), true, "so does processor time in its process group");
  await w.pass(NO_PROGRESS_MS);
  assert.equal(blocking(key), false);
  assert.match(w.lines.at(-1)!, /wrote nothing and used no processor time for 30 min\.$/);
});

test("without a recent look at the process table, a quiet turn is not judged", async t => {
  const w = world(t);
  const key = `transfer-${"b".repeat(48)}`;
  w.start(5002);
  await hungRun(key, 5002);
  await w.pass(SAMPLE_MS);
  setRunWatchForTests({ now: () => w.at() + 2 * NO_PROGRESS_MS, rows: async () => { throw new Error("ps failed"); } });
  assert.equal(blocking(key), true, "Claude's JSON answer comes at the end, so silence alone proves nothing");
});

test("an exit seen without the end of the run, or an end the run never got past, frees the update later", async t => {
  const w = world(t);
  const exited = `transfer-${"c".repeat(48)}`, ended = `transfer-${"d".repeat(48)}`;
  w.start(5003); w.start(5004);
  const first = await hungRun(exited, 5003);
  first.exited();
  await w.pass(GONE_GRACE_MS);
  assert.equal(blocking(exited), false);
  assert.match(w.lines.at(-1)!, /its provider process exited, but the run never finished\.$/);
  const second = await hungRun(ended, 5004);
  second.release();
  await w.pass(ENDED_GRACE_MS - SAMPLE_MS);
  assert.equal(blocking(ended), true, "the work after a provider run gets ten minutes");
  await w.pass(SAMPLE_MS);
  assert.equal(blocking(ended), false);
  assert.match(w.lines.at(-1)!, /its provider process ended 10 min ago, but the run never finished\.$/);
});

test("work that never started a provider process, such as a Codex desktop delivery, is never judged", async t => {
  const w = world(t);
  const key = "codex-desktop-chat";
  void withoutSurvivor(() => queued(key, never));
  await settle();
  await w.pass(6 * 60 * 60_000);
  assert.equal(blocking(key), true);
  assert.equal(w.lines.length, 0);
});

test("a zombie, or a pid now used by a younger process, is gone", async t => {
  const w = world(t);
  const zombie = `transfer-${"e".repeat(48)}`, reused = `transfer-${"f".repeat(48)}`;
  w.start(5005); w.start(5006);
  await hungRun(zombie, 5005);
  await hungRun(reused, 5006);
  w.zombie(5005);
  await w.pass(SAMPLE_MS, [5006]);
  w.vanish(5006);
  await w.pass(10 * SAMPLE_MS, [5006]);
  w.start(5006);
  await w.pass(GONE_GRACE_MS, [5006]);
  assert.equal(blocking(zombie), false);
  assert.equal(blocking(reused), false, "the pid came back as another process");
  assert.deepEqual(parseProcessTable([
    "  4242  4242 Ss     0:01.25   01:07:12", "  4243  4242 R+     1-02:03:04 2-00:00:01", "header line", "1 1 S x 00:01",
  ].join("\n")), [
    { pid: 4242, pgid: 4242, stat: "Ss", cpuMs: 1_250, elapsedMs: 4_032_000 },
    { pid: 4243, pgid: 4242, stat: "R+", cpuMs: 93_784_000, elapsedMs: 172_801_000 },
  ]);
});

test("a provider run started through runProcess is watched under its chat with the real process table", async t => {
  const base = Date.now();
  let now = base;
  // The real table, with processes as much older as the test's clock moved on.
  setRunWatchForTests({ now: () => now, log: () => {},
    rows: async () => (await readProcessTable()).map(row => ({ ...row, elapsedMs: row.elapsedMs + now - base })) });
  t.after(() => setRunWatchForTests());
  const key = `transfer-${"9".repeat(48)}`;
  const run = withoutSurvivor(() => queued(key, () => runProcess("/bin/sh", ["-c", "sleep 30"], undefined, 60_000,
    stdout => ({ ok: true, text: stdout }), undefined, key)));
  await new Promise(resolve => setTimeout(resolve, 200));
  await sampleRuns();
  assert.equal(blocking(key), true);
  now += NO_PROGRESS_MS;
  await sampleRuns();
  assert.equal(blocking(key), false, "a shell asleep for half an hour shows no sign of work");
  assert.equal(abortProcesses(key), 1);
  assert.equal((await run).ok, false);
  assert.equal(isDeliveryInFlight(key), false);
});

test("a real process that exits unseen by the watch is found gone", async t => {
  let now = Date.now();
  setRunWatchForTests({ now: () => now, log: () => {} });
  t.after(() => setRunWatchForTests());
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
  const key = `transfer-${"8".repeat(48)}`;
  await hungRun(key, child.pid!);
  await sampleRuns();
  child.kill("SIGKILL");
  await new Promise(resolve => child.once("exit", resolve));
  await sampleRuns();
  now += GONE_GRACE_MS;
  assert.equal(blocking(key), false);
});
