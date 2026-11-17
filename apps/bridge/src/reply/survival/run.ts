/**
 * One provider run started by this monitor in its own folder: its files, its record, and whether a
 * newer monitor could take it over now.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { currentSurvivor, deferWhileFrozen, survivalFrozen, trackLiveRun } from ".";
import { adoptedResult, deliverRun, runOutput } from "./answers";
import { FileTail, openRunFiles, type RunFiles } from "./files";
import {
  makeRunFolder, ownStartToken, processStartToken, removeRun, takeRunRecord, writeRunRecord, type RunParser, type RunRecord,
} from "./records";

export type SurvivableRun = {
  stdio: RunFiles["stdio"];
  /** The child started: write its record and start watching it. */
  spawned: (child: ChildProcess) => void;
  /** The provider confirmed it took the prompt. */
  admit: () => void;
  /** What the run appended to stdout and stderr since the last read. */
  read: () => { stdout: string; stderr: string };
  /**
   * The run ended. `deliver(true)`: its answer is this monitor's to send now. `deliver(false)`: another
   * monitor sends it. While a replacement monitor is due, the answer waits on disk for it, and is sent
   * from there by this monitor only if the replacement does not come.
   */
  ended: (exit: { code: number | null; signal: string | null }, deliver: (owned: boolean) => void) => void;
  /** The run failed to start. */
  abandon: () => void;
};

/** Survival is for chats: a run must have a key to be found by, and a parser for its output. */
export function prepareSurvivableRun(input: { command: string; abortKey?: string; parser: RunParser; timeoutMs: number;
  stdin?: string; admission: boolean }): SurvivableRun | undefined {
  const handle = currentSurvivor();
  const key = handle?.key ?? input.abortKey;
  if (!key) return undefined;
  const runId = randomUUID();
  const folder = makeRunFolder(runId);
  let files: RunFiles;
  try { files = openRunFiles(folder, input.stdin); }
  catch (error) { removeRun(runId); throw error; }
  const out = new FileTail(files.stdoutPath), err = new FileTail(files.stderrPath);
  let record: RunRecord | undefined, untrack = () => {}, admitted = !input.admission, ended = false;
  const write = () => {
    if (!record || ended) return;
    record = { ...record, admitted, late: handle?.late ?? false };
    try { writeRunRecord(record); } catch { /* The run goes on; only a later monitor misses it. */ }
  };
  const adoptable = () => !!record && !!handle && handle.late && admitted && !ended;
  const close = () => { out.close(); err.close(); };
  return {
    stdio: files.stdio,
    spawned: (child) => {
      files.release();
      if (!child.pid) return;
      const now = Date.now();
      record = { version: 1, runId, pid: child.pid, startToken: processStartToken(child.pid), ownerPid: process.pid,
        ownerStartToken: ownStartToken(), key, ...(input.abortKey ? { abortKey: input.abortKey } : {}),
        command: input.command.slice(0, 4_096), parser: input.parser, startedAt: now, deadline: now + input.timeoutMs,
        admitted, late: handle?.late ?? false, ...(handle ? { continuation: handle.continuation } : {}) };
      if (handle) { handle.onLate = write; handle.adoptable = adoptable; }
      write();
      untrack = trackLiveRun(runId, key, adoptable);
    },
    admit: () => { if (!admitted) { admitted = true; write(); } },
    read: () => ({ stdout: out.read(), stderr: err.read() }),
    ended: (exit, deliver) => {
      const survivable = adoptable();
      if (record) {
        record = { ...record, exit };
        try { writeRunRecord(record); } catch { /* Delivered here all the same. */ }
      }
      ended = true;
      untrack();
      close();
      if (record && survivable && survivalFrozen()) {
        const left = record;
        deliver(false);
        deferWhileFrozen(() => { void deliverRun(left, adoptedResult(left, runOutput(left), false)); });
        return;
      }
      const owned = !record || takeRunRecord(runId);
      if (owned) removeRun(runId);
      deliver(owned);
    },
    abandon: () => { ended = true; untrack(); close(); files.release(); removeRun(runId); },
  };
}
