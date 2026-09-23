import { spawn, type ChildProcess } from "node:child_process";
import { computerId } from "../../mesh/identity/computer";
import { inspectRepository } from "../../mesh/catalog";
import { localMeshStore } from "../../mesh/local-remote/local";
import { environmentProcessEnv, loadEnvironment } from "../../mesh/context/env";
import type { ReplyResult } from "../payload/types";

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

/**
 * Deliveries still running, by the chat they run for, so a pause from the
 * phone can stop the one in flight instead of letting it finish unseen.
 */
const running = new Map<string, Set<ChildProcess>>();

export const STOPPED_ERROR = "Stopped: the chat was paused from the phone.";

function track(key: string, child: ChildProcess): () => void {
  const set = running.get(key) ?? new Set<ChildProcess>();
  set.add(child);
  running.set(key, set);
  return () => {
    set.delete(child);
    if (set.size === 0) running.delete(key);
  };
}

function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
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

export function runProcess(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  parse: (stdout: string) => ReplyResult,
  stdin?: string,
  key?: string,
): Promise<ReplyResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        // A delivery is itself a prompt submission; the prompt hook must not
        // hand a background run the journal kept for the live session.
        env: { ...process.env, GRANTTAP_DELIVERY: "1", ...projectEnvForCwd(cwd) },
        stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ ok: false, error: `${command} did not start: ${(error as Error).message}` });
      return;
    }
    const untrack = key ? track(key, child) : () => {};
    if (stdin != null) child.stdin?.end(stdin);
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: ReplyResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      untrack();
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (done) return;
      signalOwnedProcess(child, "SIGKILL");
      finish({ ok: false, error: `${command} did not respond within ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      finish({ ok: false, error: `${command}: ${error.message}` });
    });
    child.on("close", (code) => {
      if ((child as ChildProcess & { granttapStopped?: boolean }).granttapStopped) {
        finish({ ok: false, error: STOPPED_ERROR });
        return;
      }
      if (code !== 0) {
        finish({
          ok: false,
          error: `${command} exited with code ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 300)}`,
        });
        return;
      }
      try {
        finish(parse(stdout));
      } catch (error) {
        finish({ ok: false, error: `${command} returned an unreadable result: ${
          error instanceof Error ? error.message : String(error)
        }` });
      }
    });
  });
}
