/**
 * What each agent keeps on the disk.
 *
 * Every agent has a folder of its own — `~/.claude`, `~/.codex` — that grows
 * with transcripts, caches and installed skills and that nothing on the phone
 * could see. The numbers come from `du`, which is slow on a folder with a
 * year of transcripts, so a measurement is kept for ten minutes and refreshed
 * in the background: a load sample never waits for it.
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

export const DISK_TTL_MS = 10 * 60_000;
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

type CacheEntry = { usage?: AgentDiskUsage; measuredAt: number; pending?: Promise<void> };

/**
 * The last measurement per agent, refreshed in the background once it is
 * ten minutes old. Returns nothing for an agent that has never been measured;
 * the first sample kicks the measurement off and a later one carries it.
 */
export function createDiskUsageSampler(
  options: { home?: string; du?: DuRunner; now?: () => number; ttlMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? DISK_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  const refresh = (agent: string): void => {
    const entry = cache.get(agent) ?? { measuredAt: 0 };
    if (entry.pending) return;
    entry.pending = measureAgentDisk(agent, options)
      .then((usage) => {
        cache.set(agent, { usage: usage ?? entry.usage, measuredAt: now() });
      })
      .catch(() => {
        cache.set(agent, { usage: entry.usage, measuredAt: now() });
      });
    cache.set(agent, entry);
  };
  return {
    sample(agents: readonly string[]): Record<string, AgentDiskUsage> {
      const out: Record<string, AgentDiskUsage> = {};
      for (const agent of agents) {
        if (!(agent in AGENT_LOCATIONS)) continue;
        const entry = cache.get(agent);
        if (!entry || now() - entry.measuredAt >= ttl) refresh(agent);
        const usage = cache.get(agent)?.usage;
        if (usage) out[agent] = usage;
      }
      return out;
    },
    /** For tests: wait for any measurement in flight. */
    async settle(): Promise<void> {
      await Promise.all([...cache.values()].map((entry) => entry.pending ?? Promise.resolve()));
    },
  };
}
