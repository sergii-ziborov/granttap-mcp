/**
 * Learn which chat started a headless run while the run's process is alive.
 *
 * Claude Code and Codex give every command a chat runs that chat's id, and a run the command starts
 * inherits it. Only a headless provider process is looked at, only when no provider process lies
 * between it and this monitor (a run this monitor started for the phone is not a child), and only
 * the chat-id variables are taken from its environment; nothing read here is logged or kept beyond
 * those ids, the run's folder and its start time.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessRow } from "../machine-load/host/process-sampler";
import { readProcessDirectories } from "../helper-runs/capture";
import { headlessRun, lineageAgent, SESSION_ID, type LineageAgent } from "./headless";
import { rememberStartedRuns, type StartedBy, type StartedRun } from "./links";

const run = promisify(execFile);

/** A headless provider process, with the nearest provider process above it. */
export type StartedRunProcess = {
  pid: number;
  agent: LineageAgent;
  startedAt: number;
  folder?: string;
  sessionId?: string;
  /** The provider process that started it, and that process's chat when the listing named it. */
  above?: { agent: string; sessionId?: string };
};

/** The variable each provider gives the commands a chat runs, naming that chat. */
const VARIABLES: ReadonlyArray<readonly [LineageAgent, string]> = [
  ["claude", "CLAUDE_CODE_SESSION_ID"], ["codex", "CODEX_THREAD_ID"], ["grok", "GROK_SESSION_ID"],
];

export type ChatVariables = Partial<Record<LineageAgent, string>>;

/** `ps -E -o pid=,uid=,command=`: only the chat-id variables are taken; the rest of each line is dropped. */
export function parseChatVariables(stdout: string, uid?: number): Map<number, ChatVariables> {
  const out = new Map<number, ChatVariables>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || (uid != null && Number(match[2]) !== uid)) continue;
    const found: ChatVariables = {};
    for (const [agent, name] of VARIABLES) {
      // The environment follows the command line, so its value is the last one on the line.
      const values = [...match[3]!.matchAll(new RegExp(`(?:^|\\s)${name}=([^\\s]+)(?=\\s|$)`, "g"))];
      const value = values.at(-1)?.[1];
      if (value && SESSION_ID.test(value)) found[agent] = value;
    }
    if (Object.keys(found).length > 0) out.set(Number(match[1]), found);
  }
  return out;
}

export async function readChatVariables(pids: readonly number[]): Promise<Map<number, ChatVariables>> {
  if (pids.length === 0) return new Map();
  try {
    const { stdout } = await run("ps", ["-E", "-o", "pid=,uid=,command=", "-p", pids.join(",")],
      { encoding: "utf8", maxBuffer: 8_000_000, timeout: 5_000 });
    return parseChatVariables(String(stdout), process.getuid?.());
  } catch {
    // The error carries every environment it read; none of it leaves here.
    throw new Error("process environment unavailable");
  }
}

/** Whether this monitor started the process itself: the monitor is above it with no provider in between. */
function startedByMonitor(row: ProcessRow, above: number | undefined, parents: ReadonlyMap<number, number | undefined>,
  monitorPid: number): boolean {
  let pid = row.ppid;
  for (let depth = 0; pid != null && pid !== above && depth < 64; depth += 1) {
    if (pid === monitorPid) return true;
    pid = parents.get(pid);
  }
  return false;
}

/** The headless provider runs in a listing that a chat, not this monitor, started. */
export function startedRunProcesses(
  rows: readonly ProcessRow[],
  ownership: { agents: ReadonlyMap<number, string>; roots: ReadonlyMap<number, number> },
  sessions: ReadonlyMap<number, string>,
  sampledAt: number,
  monitorPid = process.pid,
): StartedRunProcess[] {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  return rows.filter((row) => ownership.roots.get(row.pid) === row.pid && row.pid !== monitorPid).flatMap((row) => {
    const agent = ownership.agents.get(row.pid);
    if (!lineageAgent(agent)) return [];
    const started = headlessRun(agent, row.command);
    if (!started.headless || started.resume) return [];
    const above = row.ppid != null ? ownership.roots.get(row.ppid) : undefined;
    if (startedByMonitor(row, above, parents, monitorPid)) return [];
    const aboveAgent = above != null ? ownership.agents.get(above) : undefined;
    const aboveSession = above != null ? sessions.get(above) : undefined;
    return [{
      pid: row.pid, agent, startedAt: row.elapsedMs != null ? sampledAt - row.elapsedMs : sampledAt,
      ...(started.folder ? { folder: started.folder } : {}), ...(started.sessionId ? { sessionId: started.sessionId } : {}),
      ...(aboveAgent ? { above: { agent: aboveAgent, ...(aboveSession ? { sessionId: aboveSession } : {}) } } : {}),
    }];
  });
}

/**
 * The chat a run's environment names. Only the variable of the provider directly above the run
 * counts: one inherited from a chat further up started that provider, not this run. A run with no
 * provider above it (its shell was detached) counts when exactly one chat is named.
 */
export function runParent(item: StartedRunProcess, variables: ChatVariables = {}): StartedBy | undefined {
  if (item.above) {
    const agent = item.above.agent;
    if (!lineageAgent(agent)) return undefined;
    const named = variables[agent];
    if (named) return { agent, sessionId: named };
    // The listing names a Claude chat's root by `CLAUDE_CODE_SESSION_ID`; no other provider's.
    return agent === "claude" && item.above.sessionId ? { agent, sessionId: item.above.sessionId } : undefined;
  }
  const named = Object.entries(variables) as Array<[LineageAgent, string]>;
  return named.length === 1 ? { agent: named[0]![0], sessionId: named[0]![1] } : undefined;
}

export type StartedRunReaders = {
  directories: (pids: readonly number[]) => Promise<Map<number, string>>;
  variables: (pids: readonly number[]) => Promise<Map<number, ChatVariables>>;
};

type CaptureOptions = {
  readers?: StartedRunReaders;
  remember?: (runs: StartedRun[]) => number;
  now?: () => number;
};

const MAX_READS = 3;

/** One capture per monitor: each process is looked at until it is settled, at most three times. */
export function createStartedRunCapture(options: CaptureOptions = {}) {
  const readers = options.readers ?? { directories: readProcessDirectories, variables: readChatVariables };
  const remember = options.remember ?? rememberStartedRuns;
  const now = options.now ?? Date.now;
  const settled = new Set<number>();
  const reads = new Map<number, number>();

  const examine = async (processes: readonly StartedRunProcess[]): Promise<number> => {
    const live = new Set(processes.map((item) => item.pid));
    for (const pid of [...settled]) if (!live.has(pid)) settled.delete(pid);
    for (const pid of [...reads.keys()]) if (!live.has(pid)) reads.delete(pid);
    const fresh = processes.filter((item) => !settled.has(item.pid));
    if (fresh.length === 0) return 0;
    const pids = fresh.map((item) => item.pid);
    const variables = await readers.variables(pids);
    const unplaced = fresh.filter((item) => !item.folder && !item.sessionId).map((item) => item.pid);
    const directories = unplaced.length > 0 ? await readers.directories(unplaced) : new Map<number, string>();
    const runs: StartedRun[] = [];
    for (const item of fresh) {
      const folder = item.folder ?? directories.get(item.pid);
      const count = (reads.get(item.pid) ?? 0) + 1;
      reads.set(item.pid, count);
      if (!folder && !item.sessionId) {
        if (count >= MAX_READS) settled.add(item.pid);
        continue;
      }
      settled.add(item.pid);
      const parent = runParent(item, variables.get(item.pid));
      if (!parent || parent.sessionId === item.sessionId) continue;
      runs.push({ agent: item.agent, pid: item.pid, startedAt: item.startedAt, ...(folder ? { folder } : {}),
        ...(item.sessionId ? { sessionId: item.sessionId } : {}), parent, capturedAt: now() });
    }
    return runs.length > 0 ? remember(runs) : 0;
  };

  return async (processes: readonly StartedRunProcess[]): Promise<number> => {
    try { return await examine(processes); } catch { return 0; /* The next sample tries again. */ }
  };
}

let capture = createStartedRunCapture();

/** For tests: forget which processes were looked at, and read through other tools. */
export function resetStartedRunCapture(options?: CaptureOptions): void {
  capture = createStartedRunCapture(options);
}

/** Called with every process sample; a run lives long enough to be in at least one. */
export function captureStartedRuns(processes: readonly StartedRunProcess[]): Promise<number> {
  return capture(processes);
}
