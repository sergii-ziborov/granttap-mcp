/**
 * Learn which chat started a helper run while the run's process is alive.
 *
 * The provider's own record of the run names no parent, and the parent's
 * transcript does not name the run. The live process does: a chat hands its id
 * to everything its shell starts, and the run's process inherits it. Only a
 * process already known to be a helper run has its environment read, only the
 * chat's id is kept from it, and nothing read here is ever logged.
 */
import { execFile } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";
import type { ProcessRow } from "../machine-load/host/process-sampler";
import { helperRunFolder, helperRunFoldersNamed, type HelperRunFolder } from "./kinds";
import { rememberHelperRunLinks, type HelperRunLink, type HelperRunParentAgent } from "./links";

const run = promisify(execFile);

export type HelperRunParent = { agent: HelperRunParentAgent; sessionId: string };

/** One provider process the listing shows. Its command line is searched for a generator's folder and never kept. */
export type HelperRunProcess = { pid: number; command: string; ancestor?: HelperRunParent };

export type HelperRunReaders = {
  directories: (pids: readonly number[]) => Promise<Map<number, string>>;
  parents: (pids: readonly number[]) => Promise<Map<number, HelperRunParent>>;
};

/** The variable each provider gives the commands a chat runs, naming that chat. */
const PARENT_VARIABLES: ReadonlyArray<readonly [HelperRunParentAgent, RegExp]> = [
  ["claude", /(?:^|\s)CLAUDE_CODE_SESSION_ID=([A-Za-z0-9._-]{8,128})(?=\s|$)/],
  ["codex", /(?:^|\s)CODEX_THREAD_ID=([A-Za-z0-9._-]{8,128})(?=\s|$)/],
];
const PARENT_AGENTS = new Set<string>(PARENT_VARIABLES.map(([agent]) => agent));
const MAX_FOLDER_READS = 3;
const LSOF = "/usr/sbin/lsof";

/** `lsof -Fn` prints `p<pid>`, then `n<path>` for the one descriptor asked for. */
export function parseProcessDirectories(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | undefined;
  for (const line of stdout.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith("n/") && pid != null && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

/** `ps -E -o pid=,uid=,command=`: the chat's id is taken and the rest of the line is dropped. */
export function parseProcessParents(stdout: string, uid?: number): Map<number, HelperRunParent> {
  const out = new Map<number, HelperRunParent>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || (uid != null && Number(match[2]) !== uid)) continue;
    for (const [agent, variable] of PARENT_VARIABLES) {
      const sessionId = variable.exec(match[3]!)?.[1];
      if (sessionId) { out.set(Number(match[1]), { agent, sessionId }); break; }
    }
  }
  return out;
}

export async function readProcessDirectories(pids: readonly number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  if (process.platform === "linux") {
    const out = new Map<number, string>();
    for (const pid of pids) {
      try { out.set(pid, readlinkSync(`/proc/${pid}/cwd`)); } catch { /* Exited, or not this person's. */ }
    }
    return out;
  }
  try {
    const { stdout } = await run(existsSync(LSOF) ? LSOF : "lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")],
      { encoding: "utf8", maxBuffer: 1_000_000, timeout: 5_000 });
    return parseProcessDirectories(String(stdout));
  } catch (error) {
    // The tool exits non-zero when one of the processes is gone and still lists the rest.
    return parseProcessDirectories(String((error as { stdout?: unknown }).stdout ?? ""));
  }
}

export async function readProcessParents(pids: readonly number[]): Promise<Map<number, HelperRunParent>> {
  if (pids.length === 0) return new Map();
  try {
    const { stdout } = await run("ps", ["-E", "-o", "pid=,uid=,command=", "-p", pids.join(",")],
      { encoding: "utf8", maxBuffer: 8_000_000, timeout: 5_000 });
    return parseProcessParents(String(stdout), process.getuid?.());
  } catch {
    // The error carries every environment it read; none of it leaves here.
    throw new Error("process environment unavailable");
  }
}

/** The provider processes in a listing, each with the chat of the provider process it was started under. */
export function helperRunProcesses(
  rows: readonly ProcessRow[],
  ownership: { agents: ReadonlyMap<number, string>; roots: ReadonlyMap<number, number> },
  sessions: ReadonlyMap<number, string>,
): HelperRunProcess[] {
  return rows.filter((row) => ownership.roots.get(row.pid) === row.pid).map((row) => {
    const above = row.ppid != null ? ownership.roots.get(row.ppid) : undefined;
    const agent = above != null ? ownership.agents.get(above) : undefined;
    const sessionId = above != null ? sessions.get(above) : undefined;
    return {
      pid: row.pid, command: row.command,
      ...(agent && sessionId && PARENT_AGENTS.has(agent)
        ? { ancestor: { agent: agent as HelperRunParentAgent, sessionId } } : {}),
    };
  });
}

type CaptureOptions = {
  readers?: HelperRunReaders;
  remember?: (links: HelperRunLink[]) => number;
  now?: () => number;
};

/** One capture per monitor: it remembers which processes it has already looked at. */
export function createHelperRunCapture(options: CaptureOptions = {}) {
  const readers = options.readers ?? { directories: readProcessDirectories, parents: readProcessParents };
  const remember = options.remember ?? rememberHelperRunLinks;
  const now = options.now ?? Date.now;
  const settled = new Set<number>();
  const folderReads = new Map<number, number>();

  const folderOf = (item: HelperRunProcess, directory: string | undefined): HelperRunFolder | undefined => {
    const working = helperRunFolder(directory);
    if (working) return working;
    const named = helperRunFoldersNamed(item.command);
    return named.length === 1 ? named[0] : undefined;
  };

  const examine = async (processes: readonly HelperRunProcess[]): Promise<number> => {
    const live = new Set(processes.map((item) => item.pid));
    for (const pid of [...settled]) if (!live.has(pid)) settled.delete(pid);
    for (const pid of [...folderReads.keys()]) if (!live.has(pid)) folderReads.delete(pid);
    const fresh = processes.filter((item) => !settled.has(item.pid));
    if (fresh.length === 0) return 0;
    const directories = await readers.directories(fresh.map((item) => item.pid));
    const runs: Array<{ item: HelperRunProcess; folder: HelperRunFolder }> = [];
    for (const item of fresh) {
      const directory = directories.get(item.pid);
      const folder = folderOf(item, directory);
      if (folder) { runs.push({ item, folder }); continue; }
      const reads = (folderReads.get(item.pid) ?? 0) + 1;
      folderReads.set(item.pid, reads);
      if (directory !== undefined || reads >= MAX_FOLDER_READS) settled.add(item.pid);
    }
    if (runs.length === 0) return 0;
    const parents = await readers.parents(runs.map(({ item }) => item.pid));
    const links: HelperRunLink[] = [];
    for (const { item, folder } of runs) {
      settled.add(item.pid);
      const parent = parents.get(item.pid) ?? item.ancestor;
      if (parent) {
        links.push({ folder: folder.folder, kind: folder.kind, parentAgent: parent.agent,
          parentSessionId: parent.sessionId, capturedAt: now() });
      }
    }
    return links.length > 0 ? remember(links) : 0;
  };

  return async (processes: readonly HelperRunProcess[]): Promise<number> => {
    try { return await examine(processes); } catch { return 0; }
  };
}

let capture = createHelperRunCapture();

/** For tests: forget which processes were looked at, and read through other tools. */
export function resetHelperRunCapture(options?: CaptureOptions): void {
  capture = createHelperRunCapture(options);
}

/** Called with every process sample; a helper run lives long enough to be in at least one. */
export function captureHelperRuns(processes: readonly HelperRunProcess[]): Promise<number> {
  return capture(processes);
}
