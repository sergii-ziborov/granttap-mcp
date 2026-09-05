import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandPreviewFromInput } from "../sessions/telemetry/command-preview";

const run = promisify(execFile);

export type ProcessRow = {
  pid: number;
  /** The parent, so a shell or a node worker an agent spawned counts as that agent's. */
  ppid?: number;
  cpuPercent: number;
  rssBytes: number;
  /** The full command line, arguments included. */
  command: string;
  /**
   * The executable's own path, from `ps -o comm`. A path with a space in it —
   * `~/Library/Application Support/Claude/…/claude` — cannot be recovered from
   * the command line by splitting on whitespace, which is how the Claude the
   * desktop app runs went unattributed for as long as it did.
   */
  executable?: string;
};

/** One kind of process an agent runs, by executable: `node` ×43, `zsh` ×10. */
export type ProcessGroup = {
  name: string;
  count: number;
  cpuPercent: number;
  memoryBytes: number;
};

/** One process on its own, for the list a person opens to see who eats what. */
export type ProcessLoadRow = {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
  /** What it was asked to do, without the executable's path and without secrets. */
  detail?: string;
  /** The chat it works for, when the agent's root process could be named. */
  sessionId?: string;
};

/** What one chat's processes cost together. */
export type ChatProcessLoad = {
  sessionId: string;
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
};

export type AgentProcessLoad = {
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
  /** The heaviest kinds of process, so "Claude" can be read as what it runs. */
  groups?: ProcessGroup[];
  /** The heaviest processes one by one. */
  rows?: ProcessLoadRow[];
  /** The same load by chat, for the chats whose processes could be named. */
  chats?: ChatProcessLoad[];
};

const MAX_GROUPS = 8;
const MAX_ROWS = 40;
const MAX_DETAIL = 120;
const INTERPRETERS = /^(node|bun|deno|python3?|npx)$/;

const AGENT_EXECUTABLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["claude", ["claude"]],
  ["codex", ["codex"]],
  ["cursor", ["cursor"]],
  ["grok", ["grok"]],
];

/** Parse `pid [ppid] pcpu rss remainder` lines while ignoring headings and malformed rows. */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const withParent = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (withParent) {
      rows.push({
        pid: Number(withParent[1]),
        ppid: Number(withParent[2]),
        cpuPercent: Number(withParent[3]),
        rssBytes: Number(withParent[4]) * 1024,
        command: withParent[5]!,
      });
      continue;
    }
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      cpuPercent: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      command: match[4]!,
    });
  }
  return rows;
}

/** Parse `pid remainder` lines into a map, for a second listing joined by pid. */
export function parsePidListing(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match) out.set(Number(match[1]), match[2]!);
  }
  return out;
}

/** Rows from the executable listing, with each command line joined in by pid. */
export function withCommandLines(rows: readonly ProcessRow[], commands: ReadonlyMap<number, string>): ProcessRow[] {
  return rows.map((row) => ({
    ...row,
    executable: row.executable ?? row.command,
    command: commands.get(row.pid) ?? row.command,
  }));
}

/** The executable path of a row: stated, else the command line's first word. */
export function executableOf(row: Pick<ProcessRow, "command" | "executable">): string {
  return row.executable ?? (row.command.trim().split(/\s+/)[0] ?? "");
}

function leafOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/** What to call a process: the executable's own name, wherever it lives. */
export function processGroupName(row: Pick<ProcessRow, "command" | "executable"> | string): string {
  const executable = typeof row === "string" ? row : executableOf(row);
  // npm retitles itself "npm run test:coverage"; the kind of process is npm.
  const leaf = leafOf(executable).replace(/^-/, "").split(/\s+/)[0] ?? "";
  return (leaf || "process").slice(0, 64);
}

/** Exclude desktop chat apps and framework helpers that collide with CLI names. */
function isDesktopAppHelper(path: string): boolean {
  if (path.includes("/Contents/Resources/")) return false;
  if (path.includes(".app/Contents/Frameworks/")) return true;
  return /\/(Claude|ChatGPT)\.app\//.test(path);
}

/** The arguments after the executable, when the command line repeats it. */
function argumentsOf(row: Pick<ProcessRow, "command" | "executable">): string[] {
  const command = row.command.trim();
  const executable = row.executable?.trim();
  if (executable && command.startsWith(executable)) {
    return command.slice(executable.length).trim().split(/\s+/).filter(Boolean);
  }
  return command.split(/\s+/).slice(1);
}

function agentForRow(row: Pick<ProcessRow, "command" | "executable">): string | undefined {
  const executable = executableOf(row);
  const leaf = leafOf(executable).toLowerCase();
  if (!leaf || isDesktopAppHelper(executable) || isDesktopAppHelper(row.command)) return undefined;
  for (const [agent, executables] of AGENT_EXECUTABLES) {
    if (executables.includes(leaf)) return agent;
  }
  if (INTERPRETERS.test(leaf)) {
    const script = argumentsOf(row)[0] ?? "";
    // `codex.js` is codex; the extension is how node was asked, not what ran.
    const scriptLeaf = leafOf(script).toLowerCase().replace(/\.(m?js|cjs|ts|py)$/, "");
    for (const [agent, executables] of AGENT_EXECUTABLES) {
      if (executables.includes(scriptLeaf)) return agent;
    }
  }
  return undefined;
}

/**
 * Which agent a process belongs to: the one it is, or the one that spawned
 * it. A Bash call, a node worker, a search — an agent's work is mostly done
 * by its children, and counting only the agent binary itself read "Claude:
 * one process" while forty of its children were the load.
 */
type Ownership = {
  /** pid → agent, for every process an agent is or started. */
  agents: Map<number, string>;
  /** pid → the nearest ancestor (or itself) that is the agent's own binary: one chat's root. */
  roots: Map<number, number>;
};

function attributeByAncestry(rows: readonly ProcessRow[]): Ownership {
  const direct = new Map<number, string | undefined>();
  const parent = new Map<number, number>();
  for (const row of rows) {
    direct.set(row.pid, agentForRow(row));
    if (row.ppid != null && row.ppid !== row.pid) parent.set(row.pid, row.ppid);
  }
  const agents = new Map<number, string>();
  const roots = new Map<number, number>();
  for (const row of rows) {
    let pid: number | undefined = row.pid;
    const chain: number[] = [];
    let agent: string | undefined;
    let root: number | undefined;
    for (let depth = 0; pid != null && depth < 32; depth += 1) {
      if (direct.get(pid)) { agent = direct.get(pid); root = pid; break; }
      const known = agents.get(pid);
      if (known) { agent = known; root = roots.get(pid); break; }
      chain.push(pid);
      pid = parent.get(pid);
    }
    if (!agent) continue;
    for (const member of [...chain, row.pid]) {
      agents.set(member, agent);
      if (root != null) roots.set(member, root);
    }
  }
  return { agents, roots };
}

/** The arguments a process was given, shown without its own path and without secrets. */
export function processDetail(row: Pick<ProcessRow, "command" | "executable">): string | undefined {
  const args = argumentsOf(row).join(" ");
  const preview = commandPreviewFromInput(args);
  return preview ? preview.slice(0, MAX_DETAIL) : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function attributeProcesses(
  rows: readonly ProcessRow[],
  sessions: ReadonlyMap<number, string> = new Map(),
): Record<string, AgentProcessLoad> {
  const byAgent: Record<string, AgentProcessLoad> = {};
  const groupsByAgent: Record<string, Map<string, ProcessGroup>> = {};
  const rowsByAgent: Record<string, ProcessLoadRow[]> = {};
  const chatsByAgent: Record<string, Map<string, ChatProcessLoad>> = {};
  const { agents, roots } = attributeByAncestry(rows);
  for (const row of rows) {
    const agent = agents.get(row.pid);
    if (!agent) continue;
    const current = byAgent[agent] ?? { processes: 0, cpuPercent: 0, memoryBytes: 0, groups: [] };
    byAgent[agent] = {
      processes: current.processes + 1,
      cpuPercent: round(current.cpuPercent + row.cpuPercent),
      memoryBytes: current.memoryBytes + row.rssBytes,
      groups: [],
    };
    const groups = (groupsByAgent[agent] ??= new Map());
    const name = processGroupName(row);
    const group = groups.get(name) ?? { name, count: 0, cpuPercent: 0, memoryBytes: 0 };
    groups.set(name, {
      name,
      count: group.count + 1,
      cpuPercent: round(group.cpuPercent + row.cpuPercent),
      memoryBytes: group.memoryBytes + row.rssBytes,
    });
    const root = roots.get(row.pid);
    const sessionId = root != null ? sessions.get(root) : undefined;
    const detail = processDetail(row);
    (rowsByAgent[agent] ??= []).push({
      pid: row.pid, name, cpuPercent: row.cpuPercent, memoryBytes: row.rssBytes,
      ...(detail ? { detail } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    if (sessionId) {
      const chats = (chatsByAgent[agent] ??= new Map());
      const chat = chats.get(sessionId) ?? { sessionId, processes: 0, cpuPercent: 0, memoryBytes: 0 };
      chats.set(sessionId, {
        sessionId,
        processes: chat.processes + 1,
        cpuPercent: round(chat.cpuPercent + row.cpuPercent),
        memoryBytes: chat.memoryBytes + row.rssBytes,
      });
    }
  }
  const heaviest = <T extends { cpuPercent: number; memoryBytes: number }>(a: T, b: T): number =>
    (b.cpuPercent - a.cpuPercent) || (b.memoryBytes - a.memoryBytes);
  for (const [agent, groups] of Object.entries(groupsByAgent)) {
    byAgent[agent]!.groups = [...groups.values()]
      .sort((a, b) => heaviest(a, b) || (b.count - a.count))
      .slice(0, MAX_GROUPS);
    byAgent[agent]!.rows = (rowsByAgent[agent] ?? []).sort(heaviest).slice(0, MAX_ROWS);
    const chats = [...(chatsByAgent[agent]?.values() ?? [])].sort(heaviest);
    if (chats.length > 0) byAgent[agent]!.chats = chats;
  }
  return byAgent;
}

/**
 * Which chat each agent root works for.
 *
 * The agent binary itself does not say. Claude Code hands the chat's id to
 * every MCP server it starts, in `CLAUDE_CODE_SESSION_ID`, and `ps -E` shows
 * a process's environment to its owner — so the root's descendants name the
 * root. Only the one variable is kept; the rest of an environment is exactly
 * the kind of thing that must not leave the process.
 */
export type EnvironmentReader = (pids: readonly number[]) => Promise<Map<number, string>>;

const SESSION_VARIABLE = /(?:^|\s)CLAUDE_CODE_SESSION_ID=([A-Za-z0-9._-]{8,128})(?=\s|$)/;

export function parseSessionEnvironment(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const session = SESSION_VARIABLE.exec(match[2]!)?.[1];
    if (session) out.set(Number(match[1]), session);
  }
  return out;
}

const ENV_CHUNK = 64;

export const readSessionEnvironment: EnvironmentReader = async (pids) => {
  const out = new Map<number, string>();
  for (let index = 0; index < pids.length; index += ENV_CHUNK) {
    const chunk = pids.slice(index, index + ENV_CHUNK);
    try {
      const { stdout } = await run("ps", ["-E", "-o", "pid=,command=", "-p", chunk.join(",")], {
        encoding: "utf8", maxBuffer: 8_000_000, timeout: 5_000,
      });
      for (const [pid, session] of parseSessionEnvironment(String(stdout))) out.set(pid, session);
    } catch {
      // A chunk whose processes all exited between listings is not an error.
    }
  }
  return out;
};

const RETRY_UNKNOWN_MS = 60_000;

/**
 * Root pid → chat, remembered: a root's chat does not change, and asking
 * `ps -E` about every descendant every five seconds would be its own load.
 */
export function createSessionResolver(
  read: EnvironmentReader = readSessionEnvironment,
  now: () => number = Date.now,
) {
  const known = new Map<number, string>();
  const askedAt = new Map<number, number>();
  return async (rows: readonly ProcessRow[]): Promise<Map<number, string>> => {
    const { roots } = attributeByAncestry(rows);
    const live = new Set(roots.values());
    for (const pid of [...known.keys()]) if (!live.has(pid)) { known.delete(pid); askedAt.delete(pid); }
    for (const pid of [...askedAt.keys()]) if (!live.has(pid)) askedAt.delete(pid);
    const due = [...live].filter((root) => {
      if (known.has(root)) return false;
      const asked = askedAt.get(root);
      return asked === undefined || now() - asked >= RETRY_UNKNOWN_MS;
    });
    if (due.length > 0) {
      const dueSet = new Set(due);
      const candidates = [...roots.entries()].filter(([, root]) => dueSet.has(root)).map(([pid]) => pid);
      const found = await read(candidates);
      for (const root of due) askedAt.set(root, now());
      for (const [pid, session] of found) {
        const root = roots.get(pid);
        if (root != null && dueSet.has(root) && !known.has(root)) known.set(root, session);
      }
    }
    return new Map(known);
  };
}

/**
 * Read process rows asynchronously so sampling cannot starve the relay socket.
 * Two listings: the executable path on its own, then the command line, joined
 * by pid — one listing cannot carry both once a path has a space in it.
 */
export async function sampleProcessRows(): Promise<ProcessRow[]> {
  try {
    const [{ stdout: executables }, { stdout: commands }] = await Promise.all([
      run("ps", ["-Ao", "pid=,ppid=,pcpu=,rss=,comm="], { encoding: "utf8", maxBuffer: 4_000_000, timeout: 5_000 }),
      run("ps", ["-Ao", "pid=,command="], { encoding: "utf8", maxBuffer: 4_000_000, timeout: 5_000 }),
    ]);
    return withCommandLines(parsePsOutput(String(executables)), parsePidListing(String(commands)));
  } catch {
    return [];
  }
}

let resolveSessions = createSessionResolver();

/** For tests: forget which root belongs to which chat. */
export function resetSessionResolver(read?: EnvironmentReader, now?: () => number): void {
  resolveSessions = createSessionResolver(read, now);
}

export async function sampleAgentProcesses(): Promise<Record<string, AgentProcessLoad>> {
  const rows = await sampleProcessRows();
  return attributeProcesses(rows, await resolveSessions(rows));
}
