/**
 * What each agent keeps on the disk.
 *
 * Every agent has a folder of its own — `~/.claude`, `~/.codex` — that grows
 * with transcripts, caches and installed skills. Without the Engine, a space
 * summary measures these folders with `du`, only when the workstation policy
 * asks for one (`workstation/`); the load sheet then reads that summary.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type DiskUsageEntry = { path: string; bytes: number };
export type AgentDiskUsage = {
  measuredAt: number;
  totalBytes: number;
  /** The heaviest places inside the agent's folders, heaviest first, then the rest as one. */
  entries: DiskUsageEntry[];
};

const MAX_ENTRIES = 8;

/** Where each agent keeps its state, relative to the home folder. */
export const AGENT_LOCATIONS: Readonly<Record<string, readonly string[]>> = {
  claude: [".claude", "Library/Caches/claude-cli-nodejs"],
  codex: [".codex"],
  cursor: [".cursor"],
  grok: [".grok"],
};

export type DuRunner = (paths: string[]) => Promise<string>;

const defaultDu: DuRunner = async (paths) => {
  const { stdout } = await run("du", ["-sk", ...paths], {
    encoding: "utf8", maxBuffer: 1_000_000, timeout: 120_000,
  });
  return String(stdout);
};

/** Parse `du -sk` lines (`<kilobytes>\t<path>`) into bytes by path. */
export function parseDuOutput(stdout: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (match) out.set(match[2]!, Number(match[1]) * 1024);
  }
  return out;
}

/** A path shown as the person would type it: `~/.claude/projects`. */
export function displayPath(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path === home ? "~" : path;
}

/** The heaviest entries, with everything else folded into one line. */
export function summarize(
  sizes: ReadonlyMap<string, number>, home: string, measuredAt: number,
): AgentDiskUsage {
  const sorted = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  const totalBytes = sorted.reduce((sum, [, bytes]) => sum + bytes, 0);
  const shown = sorted.slice(0, MAX_ENTRIES).map(([path, bytes]) => ({ path: displayPath(path, home), bytes }));
  const rest = sorted.slice(MAX_ENTRIES).reduce((sum, [, bytes]) => sum + bytes, 0);
  if (rest > 0) shown.push({ path: "…", bytes: rest });
  return { measuredAt, totalBytes, entries: shown };
}

/** Measure one agent's folders now: each top-level child of each location. */
export async function measureAgentDisk(
  agent: string,
  options: { home?: string; du?: DuRunner; now?: () => number } = {},
): Promise<AgentDiskUsage | undefined> {
  const home = options.home ?? homedir();
  const du = options.du ?? defaultDu;
  const targets: string[] = [];
  for (const location of AGENT_LOCATIONS[agent] ?? []) {
    const root = join(home, location);
    if (!existsSync(root)) continue;
    let children: string[] = [];
    try {
      children = readdirSync(root);
    } catch {
      continue;
    }
    if (children.length === 0) targets.push(root);
    for (const child of children) targets.push(join(root, child));
  }
  if (targets.length === 0) return undefined;
  try {
    const sizes = parseDuOutput(await du(targets));
    return summarize(sizes, home, (options.now ?? Date.now)());
  } catch {
    return undefined;
  }
}
