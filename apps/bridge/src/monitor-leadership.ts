/**
 * One publisher per computer.
 *
 * Catalog scans are expensive, so only the monitor holding `monitor.lock`
 * publishes. The lock used to name its owner by process id alone, and a process
 * id is not a durable identity: once the recorded number was recycled by an
 * unrelated long-lived process, `acquire()` refused forever, `publish()` returned
 * in silence, and the phone kept showing the computer online with no sessions
 * and no load — for as long as that stranger stayed alive.
 *
 * The lock is therefore a lease. The leader rewrites it on every publish, and a
 * lease nobody has renewed within the TTL is reclaimed no matter which process
 * now answers to that id. A refusal is reported, because a silent publisher that
 * looks online is the hardest possible failure to notice.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";

export const LEADERSHIP_TTL_MS = 5 * 60_000;
const REPORT_INTERVAL_MS = 10 * 60_000;

export type MonitorLeadership = { acquire: () => boolean; release: () => void };

export function monitorLeadership(
  now: () => number = Date.now,
  report: (message: string) => void = (message) => process.stderr.write(message),
): MonitorLeadership {
  const path = join(configDir(), "monitor.lock");
  const primary = process.env.GRANTTAP_MONITOR_PRIMARY === "1";
  const token = `${process.pid}:${randomUUID()}:${primary ? "primary" : "peer"}`;
  let leader = false;
  let reportedAt = 0;

  const read = (): string | undefined => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };

  const write = (): void => {
    writeFileSync(path, token, { mode: 0o600 });
  };

  /** A lease nobody renewed is free, whatever process now owns that id. */
  const expired = (): boolean => {
    try {
      return now() - statSync(path).mtimeMs > LEADERSHIP_TTL_MS;
    } catch {
      return true;
    }
  };

  const ownerIsAlive = (): boolean => {
    const raw = read();
    if (raw == null) return false;
    const pid = Number(raw.split(":", 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  const ownerIsPrimary = (): boolean => read()?.trim().endsWith(":primary") === true;

  const reportRefusal = (): void => {
    if (now() - reportedAt < REPORT_INTERVAL_MS) return;
    reportedAt = now();
    const holder = read()?.split(":", 1)[0] ?? "unknown";
    report(
      `[monitor] ${path} is held by pid ${holder}; this process publishes nothing `
      + "until that lease expires or is removed\n",
    );
  };

  const acquire = (): boolean => {
    if (leader && read() === token) {
      write();
      return true;
    }
    leader = false;
    mkdirSync(configDir(), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, token);
        } finally {
          closeSync(fd);
        }
        leader = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
        // The persistent LaunchAgent is the only publisher that upgrades when
        // the local package changes. Let it replace a lease held by an older,
        // long-lived per-chat MCP process; that process observes the changed
        // token on its next tick and immediately becomes a follower.
        if (primary && !ownerIsPrimary()) {
          try {
            unlinkSync(path);
          } catch {
            return false;
          }
          continue;
        }
        if (ownerIsAlive() && !expired()) {
          reportRefusal();
          return false;
        }
        try {
          unlinkSync(path);
        } catch {
          return false;
        }
      }
    }
    return false;
  };

  const release = (): void => {
    if (!leader || read() !== token) return;
    try {
      unlinkSync(path);
    } catch {
      // A successor may already have reclaimed an expired lease.
    }
    leader = false;
  };

  acquire();
  return { acquire, release };
}
