import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { isSignInFailure, providerAgent, providerSignIns, providerSignInFailure, providerExitFailure } from './auth-failure';
import { computerId } from "../../mesh/identity/computer";
import { inspectRepository } from "../../mesh/catalog";
import { localMeshStore } from "../../mesh/local-remote/local";
import { environmentProcessEnv, loadEnvironment } from "../../mesh/context/env";
import type { ReplyResult } from "../payload/types";
import { survivalEnabled, type RunParser } from "../survival";
import { prepareSurvivableRun, type SurvivableRun } from "../survival/run";
import { watchRunProcess, type RunWatch } from "../run-watch";
import { noteProviderRunEnded } from "../../background-continuation/detect";

function projectEnvForCwd(cwd?: string): NodeJS.ProcessEnv {
  if (!cwd) return {};
  try {
    const repository = inspectRepository(cwd);
    const projectId = localMeshStore().projectIdForRepository(
      repository.canonicalRepositoryId, computerId(),
    );
    return projectId ? environmentProcessEnv(loadEnvironment(projectId)) : {};
  } catch {
    return {};
  }
}

/** A chat started from the phone is not the monitor, whatever the monitor's environment says. */
export function providerProcessEnvironment(cwd?: string): NodeJS.ProcessEnv {
  const { GRANTTAP_MONITOR_PRIMARY: _monitorOnly, ...inherited } = process.env;
  const env: NodeJS.ProcessEnv = { ...inherited, GRANTTAP_DELIVERY: "1", ...projectEnvForCwd(cwd) };
  const nodeDirectory = dirname(process.execPath);
  env.PATH = [nodeDirectory, ...(env.PATH ?? '').split(delimiter)
    .filter(part => part && part !== nodeDirectory)].join(delimiter);
  return env;
}

/**
 * Deliveries still running, by the chat they run for, so a pause from the
 * phone can stop the one in flight instead of letting it finish unseen.
 */
const running = new Map<string, Set<ChildProcess>>();

/** Only children actually launched by this GrantTap process, never other desktop tasks. */
export function ownedProviderProcesses(command: string): ChildProcess[] {
  const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const expected = real(command);
  return [...new Set([...running.values()].flatMap(set => [...set]))]
    .filter(child => child.exitCode == null && real(child.spawnfile) === expected);
}

export const STOPPED_ERROR = "Stopped: the chat was paused from the phone.";

export function trackProviderProcess(key: string, child: ChildProcess): () => void {
  const set = running.get(key) ?? new Set<ChildProcess>();
  set.add(child);
  running.set(key, set);
  return () => {
    set.delete(child);
    if (set.size === 0) running.delete(key);
  };
}

export function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32" && child.pid && child.pid > 0) {
    try {
      // POSIX detached children lead a new process group. Signal descendants
      // as well as the provider CLI, without touching the monitor's group.
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // The group may already have exited; fall back to the direct child.
    }
  }
  return child.kill(signal);
}

/** Request a stop for owned child processes; count signals accepted, not exits. */
export function abortProcesses(key: string): number {
  const set = running.get(key);
  if (!set) return 0;
  let stopped = 0;
  for (const child of set) {
    if (signalOwnedProcess(child, "SIGTERM")) {
      (child as ChildProcess & { granttapStopped?: boolean }).granttapStopped = true;
      stopped += 1;
    }
  }
  return stopped;
}

export function runningProcessCount(key: string): number {
  return running.get(key)?.size ?? 0;
}

export type ProviderAdmission = {
  confirmed: (stdout: string) => boolean;
  onConfirmed?: () => void;
  withinMs: number;
  timeoutMessage: string;
};

/** How often a run's output files are read while it runs. */
const OUTPUT_POLL_MS = 100;

type Watched = {
  command: string; child: ChildProcess; run?: SurvivableRun; timeoutMs: number; parse: (stdout: string) => ReplyResult;
  stdin?: string; key?: string; admission?: ProviderAdmission;
};

export function runProcess(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  parse: (stdout: string) => ReplyResult,
  stdin?: string,
  key?: string,
  admission?: ProviderAdmission,
  /** A chat's run, written to files in its own folder so a newer monitor can take it over (`../survival`). */
  survive?: { parser: RunParser },
): Promise<ReplyResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let run: SurvivableRun | undefined;
    try {
      run = survive && survivalEnabled() ? prepareSurvivableRun({ command, abortKey: key, parser: survive.parser,
        timeoutMs, stdin, admission: !!admission }) : undefined;
      child = spawn(command, args, {
        cwd,
        // A delivery is itself a prompt submission; the prompt hook must not
        // hand a background run the journal kept for the live session.
        env: providerProcessEnvironment(cwd),
        stdio: run ? run.stdio : [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      run?.spawned(child);
    } catch (error) {
      run?.abandon();
      resolve({ ok: false, error: `${command} did not start: ${(error as Error).message}` });
      return;
    }
    watchProvider({ command, child, run, timeoutMs, parse, stdin, key, admission }, resolve);
  });
}

function watchProvider(watched: Watched, resolve: (result: ReplyResult) => void): void {
  const { command, child, run, timeoutMs, admission } = watched;
  const untrack = watched.key ? trackProviderProcess(watched.key, child) : () => {};
  // Lets a runtime update stop waiting for this run if its process goes without its end being seen here.
  const watch = watchRunProcess(child.pid);
  const state = { stdout: "", stderr: "", done: false, admissionReported: false };
  const finish = (result: ReplyResult): void => {
    if (state.done) return;
    state.done = true;
    clearTimeout(timer);
    clearTimeout(startupTimer);
    clearInterval(poll);
    untrack();
    watch.release();
    const answer = !result.ok && admission?.confirmed(state.stdout) ? { ...result, delivery: 'native' as const } : result;
    const ended = () => noteProviderRunEnded({ key: watched.key, stderr: state.stderr, result: answer });
    if (!run) { ended(); resolve(answer); return; }
    // A run another monitor delivers is handed over: this one sends nothing for it, and continues nothing.
    run.ended({ code: child.exitCode, signal: child.signalCode }, owned => {
      if (owned) ended();
      resolve(owned ? answer : { ok: true, text: '', delivery: 'handed-over' });
    });
  };
  const timer = setTimeout(() => {
    if (state.done) return;
    signalOwnedProcess(child, "SIGKILL");
    finish({ ok: false, error: `${command} did not respond within ${Math.round(timeoutMs / 1000)}s.` });
  }, timeoutMs);
  const startupTimer = admission ? setTimeout(() => {
    if (state.done || admission.confirmed(state.stdout)) return;
    signalOwnedProcess(child, "SIGKILL");
    finish({ ok: false, error: admission.timeoutMessage });
  }, admission.withinMs) : undefined;
  const output = providerOutput(watched, state, finish, () => clearTimeout(startupTimer), watch);
  const poll = run ? setInterval(output.readFiles, OUTPUT_POLL_MS) : undefined;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on("data", output.stdout);
  child.stderr?.on("data", output.stderr);
  child.on("error", (error) => finish({ ok: false, error: `${command}: ${error.message}` }));
  child.on("exit", () => watch.exited());
  child.on("close", (code) => {
    output.readFiles();
    if (!state.done) finish(closedResult(watched, state, code));
  });
  if (watched.stdin != null && !run) {
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // A CLI can finish with a valid result before it reads the whole prompt.
      // Its closed pipe must not become an uncaught exception in the bridge.
      if (error.code !== "EPIPE") finish({ ok: false, error: `${command}: ${error.message}` });
    });
    child.stdin?.end(watched.stdin);
  }
}

/** What the provider writes, read from its pipes or, for a survivable run, from its files. */
function providerOutput(watched: Watched, state: { stdout: string; stderr: string; done: boolean; admissionReported: boolean },
  finish: (result: ReplyResult) => void, admitted: () => void, watch: RunWatch) {
  const { command, child, run, admission } = watched;
  const stdout = (chunk: string) => {
    state.stdout += chunk;
    watch.output();
    if (state.done || state.admissionReported || !admission?.confirmed(state.stdout)) return;
    state.admissionReported = true;
    admitted();
    run?.admit();
    try { admission.onConfirmed?.(); }
    catch {
      signalOwnedProcess(child, "SIGTERM");
      finish({ ok: false, error: "Provider activity could not be recorded safely.", delivery: "native" });
    }
  };
  const stderr = (chunk: string) => {
    state.stderr += chunk;
    watch.output();
    if (state.done || (admission && admission.confirmed(state.stdout))) return;
    const error = providerSignInFailure(command, state.stderr);
    if (error) { providerSignIns.refused(providerAgent(command)); signalOwnedProcess(child, 'SIGKILL'); finish({ ok: false, error }); }
  };
  const readFiles = () => {
    if (!run || state.done) return;
    const read = run.read();
    if (read.stdout) stdout(read.stdout);
    if (read.stderr) stderr(read.stderr);
  };
  return { stdout, stderr, readFiles };
}

/** The answer of a provider process that exited by itself, or was stopped from the phone. */
function closedResult(watched: Watched, state: { stdout: string; stderr: string }, code: number | null): ReplyResult {
  const { command, child } = watched;
  if ((child as ChildProcess & { granttapStopped?: boolean }).granttapStopped) return { ok: false, error: STOPPED_ERROR };
  if (code !== 0) {
    const error = providerExitFailure(command, state.stderr, state.stdout, code);
    if (isSignInFailure(error)) providerSignIns.refused(providerAgent(command));
    return { ok: false, error };
  }
  providerSignIns.accepted(providerAgent(command));
  try {
    return watched.parse(state.stdout);
  } catch (error) {
    return { ok: false, error: `${command} returned an unreadable result: ${
      error instanceof Error ? error.message : String(error)
    }` };
  }
}
