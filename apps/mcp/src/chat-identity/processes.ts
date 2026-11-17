/**
 * The coding agent that started this MCP server, read from the process tree, and the files it holds open.
 *
 * A host is recognised by its own executable (or, for a Node install of Claude Code, by its script), never by
 * a working directory. Only the nearest host above this server counts: a Grok or Cursor run started from a
 * Claude Code shell inherits that chat's variables, and its MCP server belongs to the run, not to the chat.
 * Command lines are only matched against the host patterns below; nothing read here is logged or kept.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";

export type ChatHost = "claude" | "codex" | "grok" | "cursor";
export type HostProcess = { host: ChatHost; pid: number };
export type ProcessFacts = { pid: number; executable: string; args: string };

/** Launchers between a host and this server: `granttap mcp`, `npm exec`, `node -e`, a shell, a host wrapper. */
const MAX_DEPTH = 6;
const LSOF = "/usr/sbin/lsof";

function realpath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Which coding agent one process is, if any. */
export function hostOf(process: ProcessFacts, resolve: (path: string) => string = realpath): ChatHost | undefined {
  const executable = process.executable.trim();
  const real = executable.startsWith("/") ? resolve(executable) : executable;
  const name = (real.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "");
  if (name === "claude") return "claude";
  if (name === "codex") return "codex";
  if (/^grok(?:-[\w.-]+)?$/.test(name) || (name === "agent" && real.includes("/.grok/"))) return "grok";
  if (name === "cursor-agent" || (name === "agent" && real.includes("cursor-agent"))
    || /^Cursor(?: Helper(?: \([A-Za-z]+\))?)?$/.test(name)) return "cursor";
  // Claude Code installed from npm runs as a Node script.
  if (/^node(?:js)?$/.test(name) && /(?:^|[\s/\\])@anthropic-ai[/\\]claude-code[/\\]/.test(process.args)) return "claude";
  return undefined;
}

/** The nearest host in a chain that starts at this server's parent. */
export function nearestHost(chain: readonly ProcessFacts[]): HostProcess | undefined {
  for (const item of chain) {
    const host = hostOf(item);
    if (host) return { host, pid: item.pid };
  }
  return undefined;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000,
    maxBuffer: 8_000_000 });
}

/** `ps -o pid=,<column>=` lines: the pid, then the rest of the line, which may contain spaces. */
export function parseColumn(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s(.*)$/);
    if (match) out.set(Number(match[1]), match[2]!.trim());
  }
  return out;
}

/** `ps -axo pid=,ppid=`: each process's parent. */
export function parseParents(stdout: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (match) out.set(Number(match[1]), Number(match[2]));
  }
  return out;
}

function chainFrom(start: number, parents: (pid: number) => number | undefined): number[] {
  const chain: number[] = [];
  for (let pid: number | undefined = start; pid && pid > 1 && chain.length < MAX_DEPTH && !chain.includes(pid);) {
    chain.push(pid);
    pid = parents(pid);
  }
  return chain;
}

function linuxAncestry(start: number): ProcessFacts[] {
  const parent = (pid: number) => {
    try { return Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\)\s+\S+\s+/s, "").split(" ")[0]); }
    catch { return undefined; }
  };
  return chainFrom(start, parent).map(pid => {
    let executable = "", args = "";
    try { executable = readlinkSync(`/proc/${pid}/exe`); } catch { /* Another person's process, or gone. */ }
    try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "); } catch { /* As above. */ }
    return { pid, executable, args };
  });
}

function psAncestry(start: number): ProcessFacts[] {
  const parents = parseParents(run("ps", ["-axo", "pid=,ppid="]));
  const chain = chainFrom(start, pid => parents.get(pid));
  if (chain.length === 0) return [];
  const list = chain.join(",");
  const executables = parseColumn(run("ps", ["-o", "pid=,comm=", "-p", list]));
  const args = parseColumn(run("ps", ["-o", "pid=,args=", "-p", list]));
  return chain.map(pid => ({ pid, executable: executables.get(pid) ?? "", args: args.get(pid) ?? "" }));
}

/** This server's ancestors, nearest first; empty where the platform does not show them. */
export function readAncestry(start = process.ppid): ProcessFacts[] {
  try {
    if (process.platform === "linux") return linuxAncestry(start);
    if (process.platform === "darwin") return psAncestry(start);
  } catch { /* An unreadable tree names no host. */ }
  return [];
}

/** `lsof -Fn` prints `n<path>` for each open file. */
export function parseOpenFiles(stdout: string): string[] {
  return stdout.split("\n").filter(line => line.startsWith("n/")).map(line => line.slice(1));
}

/** The paths of the regular files a process holds open. */
export function readOpenFiles(pid: number): string[] {
  if (process.platform === "linux") {
    try {
      return readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
        try { return [readlinkSync(`/proc/${pid}/fd/${fd}`)]; } catch { return []; }
      }).filter(path => path.startsWith("/"));
    } catch { return []; }
  }
  if (process.platform !== "darwin") return [];
  try {
    return parseOpenFiles(run(existsSync(LSOF) ? LSOF : "lsof", ["-a", "-p", String(pid), "-d", "^txt,^mem", "-Fn"]));
  } catch (error) {
    // lsof exits non-zero for some unreadable descriptors and still lists the rest.
    return parseOpenFiles(String((error as { stdout?: unknown }).stdout ?? ""));
  }
}
