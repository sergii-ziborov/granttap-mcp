/**
 * Provider runs that outlive the monitor that started them.
 *
 * A phone message is delivered once the provider took it; its answer is owed when the turn ends,
 * which can be hours later. A runtime update used to wait for every such turn to end. A survivable
 * run instead writes to files in its own folder (`records.ts`, `files.ts`), so a newer monitor can
 * take it over: it finds the run by pid and start time, waits for it to end, and delivers its
 * answer through the continuation the delivery registered (`adoption.ts`). See README.md.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplyResult } from "../payload/types";
import type { RunContinuation } from "./records";

export type { RunContinuation, RunParser, RunRecord } from "./records";

/** What a phone delivery hands its provider run: how the answer is delivered, and whether only the answer is owed. */
export type SurvivorHandle = {
  continuation: RunContinuation;
  late: boolean;
  /** The in-flight key the delivery was queued under, set when it is queued. */
  key?: string;
  /** Told when `late` turns true, so a run already started records it. */
  onLate?: () => void;
  /** Whether a newer monitor could take the run over now; set once the run has started. */
  adoptable?: () => boolean;
};

const scope = new AsyncLocalStorage<SurvivorHandle>();

export function withSurvivor<T>(handle: SurvivorHandle, work: () => T): T { return scope.run(handle, work); }
/** Work that must not be handed to another monitor, such as a moved Task's first turn. */
export function withoutSurvivor<T>(work: () => T): T { return scope.exit(work); }
export function currentSurvivor(): SurvivorHandle | undefined { return scope.getStore(); }

export function markLate(handle: SurvivorHandle | undefined): void {
  if (!handle || handle.late) return;
  handle.late = true;
  try { handle.onLate?.(); } catch { /* The record is written again when the run ends. */ }
}

/** Off on Windows, where a run's process group cannot be signalled after its parent exits. */
export function survivalEnabled(): boolean {
  return process.platform !== "win32" && process.env.GRANTTAP_RUN_SURVIVAL !== "0";
}

/** The runs this monitor watches, by run id: the key each holds and whether another monitor could take it over. */
const live = new Map<string, { key: string; adoptable: () => boolean }>();

export function trackLiveRun(runId: string, key: string, adoptable: () => boolean): () => void {
  live.set(runId, { key, adoptable });
  return () => { live.delete(runId); };
}

/** Whether every run under `key` could be taken over by another monitor. */
export function survivableKey(key: string): boolean {
  const runs = [...live.values()].filter(run => run.key === key);
  return runs.length > 0 && runs.every(run => run.adoptable());
}

/** How many live runs another monitor could take over, and how many it could not. */
export function liveRunCounts(): { survivable: number; held: number } {
  let survivable = 0;
  for (const run of live.values()) if (run.adoptable()) survivable += 1;
  return { survivable, held: live.size - survivable };
}

/**
 * Between telling the launcher to replace this monitor and being replaced, a survivable run that
 * ends leaves its answer on disk for the next monitor; delivering it here could be cut off half way.
 */
let frozen = false;
const deferred: Array<() => void> = [];

export function freezeSurvivingRuns(): void { frozen = true; }
export function survivalFrozen(): boolean { return frozen; }
export function deferWhileFrozen(work: () => void): void { deferred.push(work); }

/** For tests in one process: forget the answers held back, as a monitor that exited would. */
export function forgetFrozenRuns(): void { frozen = false; deferred.length = 0; }

/** The replacement did not come: answers held back are delivered here after all. */
export function thawSurvivingRuns(): void {
  frozen = false;
  for (const work of deferred.splice(0)) { try { work(); } catch { /* Each delivers on its own. */ } }
}

type Settle = (data: unknown, result: ReplyResult) => Promise<void>;
const continuations = new Map<string, Settle>();

/** How a kind of delivery sends a run's answer; registered by the monitor that can send it. */
export function registerRunContinuation(kind: string, settle: Settle): void { continuations.set(kind, settle); }
export function runContinuation(kind: string): Settle | undefined { return continuations.get(kind); }
