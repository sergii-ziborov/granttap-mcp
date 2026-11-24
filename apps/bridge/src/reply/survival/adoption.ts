/**
 * A monitor taking over the runs the monitor before it left running.
 *
 * A run on record whose monitor is gone is adopted: it holds its chat's key here (`holdKey`), so the
 * chat's next message waits for it as it would have; a pause from the phone stops it; its deadline
 * still applies. When its process ends, its answer is read from its files and delivered through the
 * continuation its delivery registered, once the relay is connected. A run that ended while no
 * monitor was running is delivered the same way. A record whose monitor is still alive, such as a
 * second monitor's, is left to that monitor and looked at again later.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chatRunsUnder, holdKey } from "../in-flight";
import { signalOwnedProcess, STOPPED_ERROR, trackProviderProcess } from "../process";
import type { ReplyResult } from "../payload/types";
import { deferWhileFrozen, survivalFrozen, trackLiveRun } from ".";
import { adoptedResult, deliverRun, runOutput } from "./answers";
import { noteProviderRunEnded } from "../../background-continuation/detect";
import { ownStartToken, processAlive, runRecords, runsRoot, type RunRecord } from "./records";

export type AdoptionOptions = {
  connected: () => boolean;
  root?: string;
  pollMs?: number;
  rescanMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Whether the monitor that started a run still runs it; by default, its process is alive (this one included). */
  ownerAlive?: (record: RunRecord) => boolean;
};

function ownerAlive(record: RunRecord): boolean {
  if (record.ownerPid === process.pid) return record.ownerStartToken === undefined || record.ownerStartToken === ownStartToken();
  return processAlive(record.ownerPid, record.ownerStartToken);
}

const watched = new Set<string>();
const VERIFY_IDENTITY_MS = 30_000;
let settling = 0;

/** Answers of adopted runs being sent now; a runtime handoff waits for them. */
export function adoptedRunsSettling(): boolean { return settling > 0; }

/** A pid-only stand-in, so pause, restart and the provider's request count reach an adopted run. */
function standIn(record: RunRecord): ChildProcess & EventEmitter {
  const emitter = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(emitter, {
    pid: record.pid, spawnfile: record.command, exitCode: null, signalCode: null,
    kill: (signal?: NodeJS.Signals) => { try { process.kill(record.pid, signal ?? "SIGTERM"); return true; } catch { return false; } },
  });
  return emitter;
}

function adopt(record: RunRecord, options: Required<Pick<AdoptionOptions, "connected" | "pollMs" | "now" | "log">> & { root: string }): void {
  watched.add(record.runId);
  const child = standIn(record);
  const untrack = trackProviderProcess(record.abortKey ?? record.key, child);
  const adoptable = !!record.continuation && record.late && record.admitted;
  let ended = false;
  const unlive = trackLiveRun(record.runId, record.key, () => adoptable && !ended);
  let finish!: () => void;
  holdKey(record.key, new Promise<void>(resolve => { finish = resolve; }), record.startedAt);
  // A new task's chat waits for its first run here too, as it did in the monitor that started it.
  if (record.parser.sessionId) chatRunsUnder(record.parser.sessionId, record.key);
  /** `stderr`: what the run wrote there; only the monitor that takes the record looks at it. */
  const deliver = async (result: ReplyResult, stderr?: string) => {
    settling += 1;
    try {
      while (!options.connected()) await new Promise(resolve => setTimeout(resolve, options.pollMs));
      if (await deliverRun(record, result, options.root) && stderr !== undefined) {
        noteProviderRunEnded({ key: record.key, stderr, result });
      }
    } finally { settling -= 1; watched.delete(record.runId); }
  };
  const done = (timedOut: boolean) => {
    ended = true;
    clearInterval(timer);
    Object.assign(child, { exitCode: timedOut ? null : 0, signalCode: timedOut ? "SIGKILL" : null });
    child.emit("exit", child.exitCode, child.signalCode);
    untrack(); unlive(); finish();
    const stopped = (child as ChildProcess & { granttapStopped?: boolean }).granttapStopped;
    const output = stopped ? undefined : runOutput(record, options.root);
    const result: ReplyResult = !output ? { ok: false, error: STOPPED_ERROR } : adoptedResult(record, output, timedOut);
    options.log(`A run this monitor took over has ended${result.ok ? "" : ` (${result.error.slice(0, 120)})`}.`);
    const send = () => { void deliver(result, output?.stderr); };
    if (adoptable && survivalFrozen()) deferWhileFrozen(send); else send();
  };
  // The process's start time is read again now and then, not every second: a pid is reused only once it is free.
  let verifiedAt = -Infinity;
  const alive = () => {
    const now = options.now();
    if (now - verifiedAt < VERIFY_IDENTITY_MS && now >= verifiedAt) return processAlive(record.pid);
    verifiedAt = now;
    return processAlive(record.pid, record.startToken);
  };
  const check = () => {
    if (ended) return;
    if (!alive()) { done(false); return; }
    if (options.now() >= record.deadline) { signalOwnedProcess(child, "SIGKILL"); done(true); }
  };
  const timer = setInterval(check, options.pollMs);
  timer.unref();
  check();
}

/** Look for runs to take over now and every few seconds; returns a stop function. */
export function adoptSurvivingRuns(input: AdoptionOptions): () => void {
  const options = { root: input.root ?? runsRoot(), pollMs: input.pollMs ?? 1_000, now: input.now ?? Date.now,
    log: input.log ?? (() => {}), connected: input.connected };
  const scan = () => {
    for (const record of runRecords(options.root)) {
      if (watched.has(record.runId) || (input.ownerAlive ?? ownerAlive)(record)) continue;
      options.log(`Taking over a run the previous monitor started ${Math.round((options.now() - record.startedAt) / 60_000)} min ago.`);
      try { adopt(record, options); } catch { watched.delete(record.runId); }
    }
  };
  scan();
  const timer = setInterval(scan, input.rescanMs ?? 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
