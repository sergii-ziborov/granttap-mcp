import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, homedir, totalmem } from "node:os";
import { promisify } from "node:util";
import type { WorkstationLoad } from "../../../../packages/protocol/schema";
import type { EngineWorkstationLoad } from "../engine/protocol/engine-protocol";
import { displayPath } from "../machine-load/host/disk-usage";

const run = promisify(execFile);

export type DiskSpace = { totalBytes: number; availableBytes: number };

/** Free space of the volume that holds the home folder; one `statfs`, no walk. */
export function homeDiskSpace(home = homedir()): DiskSpace | undefined {
  try {
    const stats = statfsSync(home);
    return { totalBytes: stats.blocks * stats.bsize, availableBytes: stats.bavail * stats.bsize };
  } catch { return undefined; }
}

/** The Engine's sample, or what the operating system answers without it. */
export async function hostLoad(
  engine: EngineWorkstationLoad | undefined, now = Date.now(), home = homedir(),
): Promise<WorkstationLoad> {
  const disk = homeDiskSpace(home) ?? { totalBytes: 0, availableBytes: 0 };
  if (engine) return fromEngine(engine, disk, home);
  const swap = await swapUsage();
  return {
    observedAt: now, source: "basic", memoryTotalBytes: totalmem(),
    ...(swap ? { swapTotalBytes: swap.total, swapUsedBytes: swap.used } : {}),
    cpuPercent: await cpuPercent(), logicalCores: Math.max(1, cpus().length),
    diskTotalBytes: disk.totalBytes, diskAvailableBytes: disk.availableBytes, apps: [],
  };
}

function fromEngine(engine: EngineWorkstationLoad, disk: DiskSpace, home: string): WorkstationLoad {
  const volume = engine.volumes.find((item) => item.home);
  const percent = (tenths: number) => Math.round(tenths) / 10;
  return {
    observedAt: engine.captured_at_ms, source: "engine",
    memoryTotalBytes: engine.memory_total_bytes, memoryUsedBytes: engine.memory_used_bytes,
    swapTotalBytes: engine.swap_total_bytes, swapUsedBytes: engine.swap_used_bytes,
    cpuPercent: Math.min(100, percent(engine.cpu_percent_tenths)),
    logicalCores: Math.max(1, engine.logical_cores),
    diskTotalBytes: volume?.total_bytes ?? disk.totalBytes,
    diskAvailableBytes: volume?.available_bytes ?? disk.availableBytes,
    apps: engine.sessions.slice(0, 8).map((session) => ({
      kind: bounded(session.kind, 40) ?? "App",
      ...(bounded(session.name, 80) ? { name: bounded(session.name, 80) } : {}),
      processes: session.processes, memoryBytes: session.rss_bytes,
      cpuPercent: percent(session.cpu_percent_tenths),
      ...(session.project ? { project: bounded(displayPath(session.project, home), 160) } : {}),
    })),
  };
}

function bounded(value: string | null | undefined, max: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
}

/** `sysctl vm.swapusage` on macOS, `/proc/meminfo` on Linux. */
export async function swapUsage(platform = process.platform): Promise<{ total: number; used: number } | undefined> {
  try {
    if (platform === "darwin") {
      const { stdout } = await run("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { timeout: 2_000 });
      return parseSwapUsage(String(stdout));
    }
    if (platform === "linux") {
      const text = await readFile("/proc/meminfo", "utf8");
      const field = (name: string) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1]) * 1024;
      const total = field("SwapTotal"), free = field("SwapFree");
      return Number.isFinite(total) && Number.isFinite(free) ? { total, used: Math.max(0, total - free) } : undefined;
    }
  } catch { /* swap stays unknown */ }
  return undefined;
}

/** `total = 18432.00M  used = 17612.25M  free = 819.75M  (encrypted)` */
export function parseSwapUsage(text: string): { total: number; used: number } | undefined {
  const unit: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  const value = (name: string) => {
    const match = text.match(new RegExp(`${name} = ([\\d.]+)([KMG])`));
    return match ? Math.round(Number(match[1]) * unit[match[2]!]!) : undefined;
  };
  const total = value("total"), used = value("used");
  return total != null && used != null ? { total, used } : undefined;
}

async function cpuPercent(gapMs = 200): Promise<number> {
  const sum = () => cpus().reduce((acc, cpu) => {
    const times = cpu.times;
    return { idle: acc.idle + times.idle, all: acc.all + times.user + times.nice + times.sys + times.irq + times.idle };
  }, { idle: 0, all: 0 });
  const first = sum();
  await new Promise((resolve) => setTimeout(resolve, gapMs));
  const second = sum();
  const all = second.all - first.all;
  return all > 0 ? Math.round((1 - (second.idle - first.idle) / all) * 1_000) / 10 : 0;
}
