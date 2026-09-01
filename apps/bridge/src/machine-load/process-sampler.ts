import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type ProcessRow = {
  pid: number;
  cpuPercent: number;
  rssBytes: number;
  command: string;
};

export type AgentProcessLoad = {
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
};

const AGENT_EXECUTABLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["claude", ["claude"]],
  ["codex", ["codex"]],
  ["cursor", ["cursor"]],
  ["grok", ["grok"]],
];

/** Parse macOS ps output while ignoring headings and malformed rows. */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
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

/** Exclude desktop chat apps and framework helpers that collide with CLI names. */
function isDesktopAppHelper(command: string): boolean {
  if (command.includes("/Contents/Resources/")) return false;
  if (command.includes(".app/Contents/Frameworks/")) return true;
  return /\/(Claude|ChatGPT)\.app\//.test(command);
}

function agentForCommand(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  const program = words[0] ?? "";
  const leaf = program.split("/").pop()?.toLowerCase() ?? "";
  if (!leaf || isDesktopAppHelper(command)) return undefined;
  for (const [agent, executables] of AGENT_EXECUTABLES) {
    if (executables.includes(leaf)) return agent;
  }
  if (/^(node|bun|deno|python3?|npx)$/.test(leaf)) {
    const scriptLeaf = (words[1] ?? "").split("/").pop()?.toLowerCase() ?? "";
    for (const [agent, executables] of AGENT_EXECUTABLES) {
      if (executables.includes(scriptLeaf)) return agent;
    }
  }
  return undefined;
}

export function attributeProcesses(
  rows: readonly ProcessRow[],
): Record<string, AgentProcessLoad> {
  const byAgent: Record<string, AgentProcessLoad> = {};
  for (const row of rows) {
    const agent = agentForCommand(row.command);
    if (!agent) continue;
    const current = byAgent[agent] ?? { processes: 0, cpuPercent: 0, memoryBytes: 0 };
    byAgent[agent] = {
      processes: current.processes + 1,
      cpuPercent: Math.round((current.cpuPercent + row.cpuPercent) * 100) / 100,
      memoryBytes: current.memoryBytes + row.rssBytes,
    };
  }
  return byAgent;
}

/** Read process rows asynchronously so sampling cannot starve the relay socket. */
export async function sampleProcessRows(): Promise<ProcessRow[]> {
  try {
    const { stdout } = await run("ps", ["-Ao", "pid=,pcpu=,rss=,command="], {
      encoding: "utf8",
      maxBuffer: 4_000_000,
      timeout: 5_000,
    });
    return parsePsOutput(String(stdout));
  } catch {
    return [];
  }
}

export async function sampleAgentProcesses(): Promise<Record<string, AgentProcessLoad>> {
  return attributeProcesses(await sampleProcessRows());
}
