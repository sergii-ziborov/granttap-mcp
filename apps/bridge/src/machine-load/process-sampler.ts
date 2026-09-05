import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export type AgentProcessLoad = {
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
  /** The heaviest kinds of process, so "Claude" can be read as what it runs. */
  groups?: ProcessGroup[];
};

const MAX_GROUPS = 8;
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
function attributeByAncestry(rows: readonly ProcessRow[]): Map<number, string> {
  const direct = new Map<number, string | undefined>();
  const parent = new Map<number, number>();
  for (const row of rows) {
    direct.set(row.pid, agentForRow(row));
    if (row.ppid != null && row.ppid !== row.pid) parent.set(row.pid, row.ppid);
  }
  const resolved = new Map<number, string>();
  for (const row of rows) {
    let pid: number | undefined = row.pid;
    const chain: number[] = [];
    let agent: string | undefined;
    for (let depth = 0; pid != null && depth < 32; depth += 1) {
      const known = resolved.get(pid) ?? direct.get(pid);
      if (known) { agent = known; break; }
      chain.push(pid);
      pid = parent.get(pid);
    }
    if (!agent) continue;
    for (const member of chain) resolved.set(member, agent);
    resolved.set(row.pid, agent);
  }
  return resolved;
}

export function attributeProcesses(
  rows: readonly ProcessRow[],
): Record<string, AgentProcessLoad> {
  const byAgent: Record<string, AgentProcessLoad> = {};
  const groupsByAgent: Record<string, Map<string, ProcessGroup>> = {};
  const owners = attributeByAncestry(rows);
  for (const row of rows) {
    const agent = owners.get(row.pid);
    if (!agent) continue;
    const current = byAgent[agent] ?? { processes: 0, cpuPercent: 0, memoryBytes: 0, groups: [] };
    byAgent[agent] = {
      processes: current.processes + 1,
      cpuPercent: Math.round((current.cpuPercent + row.cpuPercent) * 100) / 100,
      memoryBytes: current.memoryBytes + row.rssBytes,
      groups: [],
    };
    const groups = (groupsByAgent[agent] ??= new Map());
    const name = processGroupName(row);
    const group = groups.get(name) ?? { name, count: 0, cpuPercent: 0, memoryBytes: 0 };
    groups.set(name, {
      name,
      count: group.count + 1,
      cpuPercent: Math.round((group.cpuPercent + row.cpuPercent) * 100) / 100,
      memoryBytes: group.memoryBytes + row.rssBytes,
    });
  }
  for (const [agent, groups] of Object.entries(groupsByAgent)) {
    byAgent[agent]!.groups = [...groups.values()]
      .sort((a, b) => (b.cpuPercent - a.cpuPercent) || (b.memoryBytes - a.memoryBytes) || (b.count - a.count))
      .slice(0, MAX_GROUPS);
  }
  return byAgent;
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

export async function sampleAgentProcesses(): Promise<Record<string, AgentProcessLoad>> {
  return attributeProcesses(await sampleProcessRows());
}
