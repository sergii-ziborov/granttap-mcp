import { execFile } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { promisify } from "node:util";
import type { WorkstationSettings, WorkstationSnapshot, WorkstationSpace } from "../../../../packages/protocol/schema";
import type { ScanTrigger } from "./space";

const run = promisify(execFile);
const GIB = 1024 ** 3;
export const LOW_SPACE_BYTES = 10 * GIB;
export const CRITICAL_SPACE_BYTES = 3 * GIB;
/** An alert is sent again only after space came back this far above its level. */
const REARM_BYTES = 5 * GIB;
const HOUR = 3_600_000;
export const WATCH_INTERVAL_MS = 5 * 60_000;
const SETTLE_MS = 3 * 60_000;

export type LowSpace = WorkstationSnapshot["lowSpace"];

export function lowSpaceLevel(availableBytes: number): LowSpace {
  return availableBytes < CRITICAL_SPACE_BYTES ? "critical" : availableBytes < LOW_SPACE_BYTES ? "low" : "ok";
}

/** Once per level: `alerted` is the most severe level already told and not yet re-armed. */
export function lowSpaceAlert(alerted: LowSpace, availableBytes: number): { send?: "low" | "critical"; alerted: LowSpace } {
  let state = alerted;
  if (state === "critical" && availableBytes >= CRITICAL_SPACE_BYTES + REARM_BYTES) state = "low";
  if (state === "low" && availableBytes >= LOW_SPACE_BYTES + REARM_BYTES) state = "ok";
  const level = lowSpaceLevel(availableBytes);
  if (level === "critical" && state !== "critical") return { send: "critical", alerted: "critical" };
  if (level === "low" && state === "ok") return { send: "low", alerted: "low" };
  return { alerted: state };
}

export type ScanConditions = { availableBytes: number; busy: boolean; onBattery: () => Promise<boolean> };

/**
 * When this computer measures on its own. Never with `off`; never in the first
 * minutes after a start. Soon when space runs low or drops sharply since the
 * last summary, and otherwise once a day while it is idle and on a charger.
 */
export async function automaticScanReason(
  settings: WorkstationSettings, last: WorkstationSpace | undefined, startedAt: number,
  conditions: ScanConditions, now: number,
): Promise<ScanTrigger | undefined> {
  if (settings.automaticScan === "off" || now - startedAt < SETTLE_MS) return undefined;
  const since = last ? now - last.scannedAt : Number.POSITIVE_INFINITY;
  const level = lowSpaceLevel(conditions.availableBytes);
  if (level !== "ok" && since >= HOUR && (!conditions.busy || level === "critical")) return "low-space";
  if (conditions.busy) return undefined;
  const before = last?.diskAvailableBytes;
  if (before != null && before - conditions.availableBytes >= 10 * GIB && since >= HOUR / 2) return "space-drop";
  if (since >= 24 * HOUR && !(await conditions.onBattery())) return "daily";
  return undefined;
}

/** A five-minute load above three quarters of the cores means people or builds are using it. */
export function hostBusy(load = loadavg()[1] ?? 0, cores = cpus().length): boolean {
  return load / Math.max(1, cores) > 0.75;
}

export async function onBatteryPower(platform = process.platform): Promise<boolean> {
  if (platform !== "darwin") return false;
  try {
    const { stdout } = await run("/usr/bin/pmset", ["-g", "batt"], { timeout: 2_000 });
    return String(stdout).includes("'Battery Power'");
  } catch { return false; }
}

export function lowSpaceMessage(level: "low" | "critical", availableBytes: number, computer: string): string {
  const free = (availableBytes / GIB).toFixed(1);
  return level === "critical"
    ? `${computer} has only ${free} GB free on its disk. Agents, builds and GrantTap itself can fail when it fills up.`
    : `${computer} is running low on disk space: ${free} GB free.`;
}

export type WatchDependencies = {
  tick: () => Promise<void>;
  schedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  cancel?: (timer: NodeJS.Timeout) => void;
};

/** Every five minutes: one `statfs`, an alert when needed, and a summary only when the policy asks. */
export function startWatchLoop(dependencies: WatchDependencies): () => void {
  const schedule = dependencies.schedule ?? setTimeout;
  const cancel = dependencies.cancel ?? clearTimeout;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const next = (delayMs: number) => {
    if (stopped) return;
    timer = schedule(() => {
      void dependencies.tick().catch(() => {}).finally(() => next(WATCH_INTERVAL_MS));
    }, delayMs);
    timer.unref?.();
  };
  next(SETTLE_MS);
  return () => { stopped = true; if (timer) cancel(timer); };
}
