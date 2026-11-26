import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withStoreLock } from "../../../../../packages/core/store-file-lock";
import { writePrivateFile } from "../../config/access/write-private";
import { configDir } from "../../config/runtime/paths";

/** Which GrantTap process answers: the background monitor, the local MCP service, or a chat's stdio MCP server. */
export type PollerRole = "monitor" | "service" | "chat";
const ROLES: readonly PollerRole[] = ["monitor", "service", "chat"];
export const POLLER_LABELS: Record<PollerRole, string> = {
  monitor: "the background helper", service: "the MCP service", chat: "a chat's MCP server",
};
type Lease = { holder: string; pid: number; role: PollerRole; renewedAt: number };

/** A holder renews on every ten-second tick; one silent this long (a hung process) is replaced. */
export const LEASE_STALE_MS = 45_000;

const leasePath = () => join(configDir(), "account-poller-lease.json");

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function readLease(): Lease | null {
  try {
    const row = JSON.parse(readFileSync(leasePath(), "utf8")) as Partial<Lease>;
    if (typeof row.holder !== "string" || !Number.isSafeInteger(row.pid) || (row.pid ?? 0) <= 0
      || !ROLES.includes(row.role as PollerRole) || typeof row.renewedAt !== "number") return null;
    return row as Lease;
  } catch { return null; }
}

type LeaseOptions = { now?: () => number; staleMs?: number; alive?: (pid: number) => boolean; pid?: number };

/**
 * One account-recovery poller per computer. Every GrantTap process that could answer a phone signing in with
 * the account asks for this lease on each tick, and only its holder polls, so two processes never answer the
 * same request. The decision runs under the lease file's lock; a lease whose process is gone, or that was not
 * renewed for `LEASE_STALE_MS`, is taken over by the next process that asks. The file is owner-only and names
 * a process, never a credential.
 */
export class AccountPollLease {
  readonly holder = randomBytes(8).toString("hex");
  private held = false;

  constructor(readonly role: PollerRole, private readonly options: LeaseOptions = {}) {}

  private get now(): number { return (this.options.now ?? Date.now)(); }
  private get pid(): number { return this.options.pid ?? process.pid; }

  private free(current: Lease | null, now: number): boolean {
    if (!current || current.holder === this.holder) return true;
    const staleMs = this.options.staleMs ?? LEASE_STALE_MS;
    // A renewal from the future is a clock that moved back: not evidence of a live holder.
    if (now - current.renewedAt > staleMs || current.renewedAt - now > staleMs) return true;
    return !(this.options.alive ?? processAlive)(current.pid);
  }

  /** Take the lease or renew it; true when this process is the one that polls now. */
  claim(): boolean {
    try {
      const held = withStoreLock(leasePath(), () => {
        const now = this.now;
        const current = readLease();
        if (!this.free(current, now)) return false;
        writePrivateFile(leasePath(), `${JSON.stringify({ holder: this.holder, pid: this.pid, role: this.role, renewedAt: now })}\n`);
        return true;
      }, { waitMs: 200 });
      if (held && !this.held) {
        process.stderr.write(`[account] ${POLLER_LABELS[this.role]} (pid ${this.pid}) answers phones signing in with the account\n`);
      }
      this.held = held;
      return held;
    } catch {
      // A busy lock is another process deciding: this tick is skipped, the next one asks again.
      return false;
    }
  }

  /** Give the lease up on a clean stop, so another process can answer at once. */
  release(): void {
    this.held = false;
    try {
      withStoreLock(leasePath(), () => {
        if (readLease()?.holder === this.holder) rmSync(leasePath(), { force: true });
      }, { waitMs: 200 });
    } catch { /* left to go stale */ }
  }
}

/** The process answering phones right now, read without taking anything; null when none holds a live lease. */
export function activeAccountPoller(now = Date.now(), alive: (pid: number) => boolean = processAlive):
  { role: PollerRole; pid: number } | null {
  const lease = readLease();
  if (!lease || Math.abs(now - lease.renewedAt) > LEASE_STALE_MS || !alive(lease.pid)) return null;
  return { role: lease.role, pid: lease.pid };
}
