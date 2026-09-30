/** Parse and sample operating-system process rows. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessRow } from "./process-sampler";

const run = promisify(execFile);

/** Parse `pid [ppid] pcpu rss remainder` lines while ignoring headings and malformed rows. */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const timed = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d:.-]+)\s+([\d:.-]+)\s+(.+)$/);
    if (timed && timed[5]!.includes(":") && timed[6]!.includes(":")) {
      const cpuTimeMs = parsePsClock(timed[5]!);
      const elapsedMs = parsePsClock(timed[6]!);
      rows.push({
        pid: Number(timed[1]), ppid: Number(timed[2]),
        cpuPercent: Number(timed[3]), rssBytes: Number(timed[4]) * 1024,
        command: timed[7]!,
        ...(cpuTimeMs != null ? { cpuTimeMs } : {}),
        ...(elapsedMs != null ? { elapsedMs } : {}),
      });
      continue;
    }
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

/** macOS ps clocks use [[days-]hours:]minutes:seconds.centiseconds. */
export function parsePsClock(value: string): number | undefined {
  const [dayPart, clock] = value.includes("-") ? value.split("-", 2) : ["0", value];
  const parts = clock?.split(":").map(Number) ?? [];
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const days = Number(dayPart);
  if (!Number.isFinite(days) || days < 0) return undefined;
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0) + days * 86_400;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
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

/**
 * Read process rows asynchronously so sampling cannot starve the relay socket.
 * Two listings: the executable path on its own, then the command line, joined
 * by pid — one listing cannot carry both once a path has a space in it.
 */
export async function sampleProcessRows(): Promise<ProcessRow[]> {
  try {
    const [{ stdout: executables }, { stdout: commands }] = await Promise.all([
      run("ps", ["-Ao", "pid=,ppid=,pcpu=,rss=,time=,etime=,comm="], { encoding: "utf8", maxBuffer: 4_000_000, timeout: 5_000 }),
      run("ps", ["-Ao", "pid=,command="], { encoding: "utf8", maxBuffer: 4_000_000, timeout: 5_000 }),
    ]);
    return withCommandLines(parsePsOutput(String(executables)), parsePidListing(String(commands)));
  } catch {
    return [];
  }
}
