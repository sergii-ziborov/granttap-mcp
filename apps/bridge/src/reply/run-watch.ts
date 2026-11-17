/**
 * Whether a run in flight still runs. A run's place in `in-flight.ts` is freed when this monitor sees its
 * provider process end, or at its deadline, hours away for a phone run. When the end is never seen, or the
 * process hangs, the run held a runtime update back until that deadline: a moved Task's turn cannot be
 * handed over, and each hold that gave up waited for it to end. This watches the provider processes started
 * under each in-flight key, so the update stops waiting for a run whose process is gone, or that showed no
 * sign of work for a long time. The run itself is left alone; only the update stops counting it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { parsePsClock } from "../machine-load/host/ps-reader";

/** A provider process that exited, or vanished, this long ago no longer holds an update back. */
export const GONE_GRACE_MS = 2 * 60_000;
/** Work still pending this long after its last provider process ended normally no longer holds an update back. */
export const ENDED_GRACE_MS = 10 * 60_000;
/** A provider process with no output and no processor time in its process group for this long no longer does either. */
export const NO_PROGRESS_MS = 30 * 60_000;
/** How often watched processes are looked at, and the processor time between two looks that counts as work. */
export const SAMPLE_MS = 60_000;
const ACTIVE_CPU_MS = 1_000;

export type ProcessRow = { pid: number; pgid: number; stat: string; cpuMs: number; elapsedMs: number };
type Watched = {
  pid: number; keys: readonly string[]; startedAt: number; signAt: number;
  endedAt?: number; how?: "exited" | "gone"; cpuMs?: number; sampledAt?: number;
};

const scope = new AsyncLocalStorage<readonly string[]>();
const watched = new Set<Watched>();
/** Keys whose last provider process ended while their work went on, and when. */
const endedAt = new Map<string, number>();
const reported = new Map<string, string>();
let clock = Date.now;
let readRows: () => Promise<ProcessRow[]> = readProcessTable;
let log = (line: string): void => { process.stderr.write(`[monitor] ${line}\n`); };
let sampler: ReturnType<typeof setInterval> | undefined;

/** Runs `work` as the in-flight work of `key`: provider processes it starts are watched for it and the keys around it. */
export function withinDelivery<T>(key: string, work: () => T): T {
  endedAt.delete(key);
  return scope.run([...(scope.getStore() ?? []), key], work);
}

/** The key settled: nothing about it is kept. */
export function forgetDelivery(key: string): void {
  endedAt.delete(key);
  reported.delete(key);
}

export type RunWatch = { output: () => void; exited: () => void; release: () => void };
const unwatched: RunWatch = { output() {}, exited() {}, release() {} };

/**
 * Watch a provider process started for the work in flight here. `output`: it wrote something; `exited`:
 * this monitor saw it exit; `release`: its run has finished, whatever the outcome.
 */
export function watchRunProcess(pid: number | undefined): RunWatch {
  const keys = scope.getStore();
  if (!keys?.length || !pid) return unwatched;
  const now = clock();
  const run: Watched = { pid, keys, startedAt: now, signAt: now };
  watched.add(run);
  for (const key of keys) endedAt.delete(key);
  startSampling();
  return {
    output: () => { run.signAt = clock(); },
    exited: () => { if (run.endedAt === undefined) { run.endedAt = clock(); run.how = "exited"; } },
    release: () => {
      if (!watched.delete(run)) return;
      const at = clock();
      for (const key of keys) if (![...watched].some(other => other.keys.includes(key))) endedAt.set(key, at);
      if (watched.size === 0) stopSampling();
    },
  };
}

const gone = (run: Watched, now: number) => run.endedAt !== undefined && now - run.endedAt >= GONE_GRACE_MS;
// Without a recent look at the process table, quiet output alone proves nothing: Claude's JSON comes at the end.
const quiet = (run: Watched, now: number) => run.sampledAt !== undefined && now - run.sampledAt <= 3 * SAMPLE_MS
  && now - run.signAt >= NO_PROGRESS_MS;

function reason(key: string, now: number): string | undefined {
  const runs = [...watched].filter(run => run.keys.includes(key));
  if (runs.length === 0) {
    const ended = endedAt.get(key);
    return ended !== undefined && now - ended >= ENDED_GRACE_MS
      ? `its provider process ended ${minutes(now - ended)} min ago, but the run never finished` : undefined;
  }
  if (runs.every(run => gone(run, now))) {
    return runs.some(run => run.how === "gone") ? "its provider process is gone" : "its provider process exited, but the run never finished";
  }
  return runs.every(run => gone(run, now) || quiet(run, now))
    ? `its provider process wrote nothing and used no processor time for ${minutes(NO_PROGRESS_MS)} min` : undefined;
}

/**
 * Why the work in flight under `key`, waiting since `since`, no longer holds a runtime update back; undefined
 * while it may still be running. Work that never started a provider process (a Codex desktop delivery) is
 * never judged here. The first time a reason holds, the monitor log says so.
 */
export function stalledDelivery(key: string, since: number): string | undefined {
  const now = clock(), why = reason(key, now);
  if (why && reported.get(key) !== why) {
    reported.set(key, why);
    log(`A runtime update no longer waits for the run ${label(key)} that started ${minutes(now - since)} min ago: ${why}.`);
  }
  return why;
}

function label(key: string): string {
  const task = /^__new_([a-z]+)_task__/.exec(key)?.[1];
  return task ? `of a new ${task} task` : `in chat ${key.slice(0, 16)}`;
}

/** Look at every watched process once: gone, a zombie, a reused pid, or how much processor time its group used. */
export async function sampleRuns(): Promise<void> {
  if (watched.size === 0) return;
  let rows: ProcessRow[];
  try { rows = await readRows(); } catch { return; }
  const now = clock();
  for (const run of watched) {
    if (run.endedAt !== undefined) continue;
    const leader = rows.find(row => row.pid === run.pid);
    // A pid reused by a later process is younger than the run.
    if (!leader || leader.stat.startsWith("Z") || leader.elapsedMs < now - run.startedAt - SAMPLE_MS) {
      run.endedAt = now; run.how = "gone"; continue;
    }
    const group = leader.pgid === leader.pid ? rows.filter(row => row.pgid === leader.pid && !row.stat.startsWith("Z")) : [leader];
    const cpu = group.reduce((sum, row) => sum + row.cpuMs, 0);
    if (run.cpuMs !== undefined && cpu - run.cpuMs >= ACTIVE_CPU_MS) run.signAt = now;
    run.cpuMs = cpu;
    run.sampledAt = now;
  }
}

function startSampling(): void {
  if (sampler) return;
  sampler = setInterval(() => { void sampleRuns(); }, SAMPLE_MS);
  sampler.unref?.();
}

function stopSampling(): void {
  if (sampler) clearInterval(sampler);
  sampler = undefined;
}

/** `pid pgid stat time etime` rows, as `ps -A -o pid=,pgid=,stat=,time=,etime=` prints them on macOS and Linux. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  return stdout.split("\n").flatMap((line): ProcessRow[] => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
    if (!match) return [];
    const cpuMs = parsePsClock(match[4]!), elapsedMs = parsePsClock(match[5]!);
    return cpuMs == null || elapsedMs == null ? []
      : [{ pid: Number(match[1]), pgid: Number(match[2]), stat: match[3]!, cpuMs, elapsedMs }];
  });
}

export function readProcessTable(): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-o", "pid=,pgid=,stat=,time=,etime="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => { if (error) reject(error); else resolve(parseProcessTable(stdout)); });
  });
}

function minutes(ms: number): number { return Math.max(0, Math.round(ms / 60_000)); }

/** For tests in one process: a clock, a process table and a log instead of the system's; nothing watched is kept. */
export function setRunWatchForTests(options: { now?: () => number; rows?: () => Promise<ProcessRow[]>;
  log?: (line: string) => void } = {}): void {
  stopSampling();
  watched.clear(); endedAt.clear(); reported.clear();
  clock = options.now ?? Date.now;
  readRows = options.rows ?? readProcessTable;
  log = options.log ?? ((line: string) => { process.stderr.write(`[monitor] ${line}\n`); });
}
