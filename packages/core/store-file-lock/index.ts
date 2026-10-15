import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 5;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The lock could not be taken in time. The write is kept in memory and tried again later. */
export class StoreLockError extends Error {}

type LockOwner = { pid: number; token: string };

function lockOwner(lock: string): LockOwner | undefined {
  try {
    const [pid, token] = readFileSync(join(lock, "owner"), "utf8").trim().split(":");
    const parsed = Number(pid);
    return Number.isInteger(parsed) && parsed > 0 && token ? { pid: parsed, token } : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take a lock whose owner is gone: moved aside first, so two waiters cannot both take it. */
function takeOverStale(lock: string): void {
  const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // Someone else took it over first.
  }
  rmSync(aside, { recursive: true, force: true });
}

/**
 * Run under the store's lock: a directory beside the file, the one thing a
 * file system creates atomically, naming the process that holds it.
 *
 * A lock whose owner is no longer running is taken over at once; a lock whose
 * owner is alive is waited for, and when the wait runs out the caller gets a
 * StoreLockError instead of the critical section. A lock is released only by
 * the process and token that took it, so an owner that finishes late never
 * removes a lock taken over meanwhile.
 */
export function withStoreLock<T>(path: string, run: () => T, options: { waitMs?: number } = {}): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const token = randomBytes(8).toString("hex");
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), `${process.pid}:${token}`, { mode: 0o600 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw new StoreLockError(`the store lock could not be taken (${code ?? String(error)})`);
      const owner = lockOwner(lock);
      if (owner && !processAlive(owner.pid)) {
        takeOverStale(lock);
        continue;
      }
      if (!owner && lockAge(lock) > waitMs) {
        // A lock without an owner file for this long was never finished being taken.
        takeOverStale(lock);
        continue;
      }
      if (Date.now() - started > waitMs) {
        throw new StoreLockError("the store lock is held by another running process");
      }
      pause(LOCK_POLL_MS);
    }
  }
  try {
    return run();
  } finally {
    const owner = lockOwner(lock);
    if (owner && owner.pid === process.pid && owner.token === token) {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

function lockAge(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}
