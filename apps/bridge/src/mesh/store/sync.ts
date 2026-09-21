/**
 * Two processes, one file.
 *
 * The monitor and each MCP server hold a MeshStore over the same
 * `project-mesh.json`. Each used to load the file once and write it whole, so
 * the last writer replaced whatever the other had written since: a Task
 * linked by one process vanished when the other saved a claim. A store now
 * reloads the file whenever it has changed under it, and saves by merging
 * what it changed since the last sync into what is on disk, under a lock
 * beside the file that is held by a named, living process.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExecutionSessionLink as ExecutionValue,
  IntegrationPeer as IntegrationPeerValue,
  MeshTask as TaskValue,
} from "../../../../../packages/protocol/schema";
import { preferExecution, preferTask } from "../admin/convergence";
import { integrationPeerKey } from "../handoff/other-side";
import {
  MAX_RELEASED_CLAIMS, MAX_STORE_MIGRATIONS, MAX_STORE_PEERS, type StoreState,
} from "./state";

type Collection = Exclude<keyof StoreState, "version">;

const COLLECTIONS: Collection[] = [
  "projects", "bindings", "peers", "tasks", "executions", "claims", "dependencies", "events",
  "knowledge", "receipts", "migrations", "releasedClaims",
];
const BOUNDS: Partial<Record<Collection, number>> = {
  peers: MAX_STORE_PEERS, events: 512, receipts: 256, migrations: MAX_STORE_MIGRATIONS,
  knowledge: 256, releasedClaims: MAX_RELEASED_CLAIMS,
};
/**
 * A write takes milliseconds, so a lock held for seconds belongs to a
 * process that is stuck; waiting longer than this only stalls this one.
 */
export const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 5;

function rowKey(name: Collection, item: unknown): string {
  const row = item as Record<string, string | undefined>;
  switch (name) {
    case "projects": return row.projectId ?? "";
    case "bindings": return row.bindingId ?? "";
    case "peers": return integrationPeerKey(item as IntegrationPeerValue);
    case "tasks": return row.taskId ?? "";
    case "executions": return [row.computerId, row.provider, row.sessionId].join("\0");
    case "claims": return row.claimId ?? "";
    case "dependencies": return [row.taskId, row.dependsOnTaskId].join("\0");
    case "events": return row.eventId ?? "";
    case "knowledge": return [row.projectId, row.recordId].join("\0");
    case "receipts": return row.capsuleHash ?? "";
    case "migrations": return row.capsuleHashFrom ?? "";
    case "releasedClaims": return row.claimId ?? "";
  }
}

type Upsert = { item: unknown; before?: string };
/** A removal names the row as it was read, so a row changed meanwhile is kept. */
type Removal = { key: string; before: string };
export type StoreDelta = Record<Collection, { upserts: Upsert[]; removed: Removal[] }>;

/** What this process changed since it last agreed with the disk. */
export function storeDelta(baseline: StoreState, current: StoreState): StoreDelta {
  const delta = {} as StoreDelta;
  for (const name of COLLECTIONS) {
    const before = new Map<string, string>();
    for (const item of baseline[name] ?? []) before.set(rowKey(name, item), JSON.stringify(item));
    const after = new Set<string>();
    const upserts: Upsert[] = [];
    for (const item of current[name] ?? []) {
      const key = rowKey(name, item);
      after.add(key);
      const previous = before.get(key);
      if (previous !== JSON.stringify(item)) upserts.push({ item, before: previous });
    }
    const removed: Removal[] = [];
    for (const [key, previous] of before) {
      if (!after.has(key)) removed.push({ key, before: previous });
    }
    delta[name] = { upserts, removed };
  }
  return delta;
}

export function deltaIsEmpty(delta: StoreDelta): boolean {
  return COLLECTIONS.every((name) =>
    delta[name].upserts.length === 0 && delta[name].removed.length === 0);
}

/**
 * This process's changes laid over what another process wrote meanwhile. A
 * row only we changed is ours; a row both changed is settled the way two
 * computers settle it, so every process converges on the same file. A row
 * we removed is removed only as we read it: a claim renewed by another
 * process since is not the claim we decided had expired.
 */
export function applyStoreDelta(disk: StoreState, delta: StoreDelta): StoreState {
  const merged: Record<string, unknown> = { ...disk };
  for (const name of COLLECTIONS) {
    const { upserts, removed } = delta[name];
    if (upserts.length === 0 && removed.length === 0) continue;
    const gone = new Map(removed.map((removal) => [removal.key, removal.before]));
    const rows = new Map<string, unknown>();
    for (const item of disk[name] ?? []) {
      const key = rowKey(name, item);
      const asRead = gone.get(key);
      if (asRead != null && asRead === JSON.stringify(item)) continue;
      rows.set(key, item);
    }
    for (const { item, before } of upserts) {
      const key = rowKey(name, item);
      const theirs = rows.get(key);
      const untouched = theirs == null || JSON.stringify(theirs) === before;
      rows.set(key, untouched ? item : settle(name, theirs, item));
    }
    let items = [...rows.values()];
    const bound = BOUNDS[name];
    if (bound != null && items.length > bound) items = items.slice(-bound);
    merged[name] = items;
  }
  return merged as StoreState;
}

function settle(name: Collection, theirs: unknown, ours: unknown): unknown {
  if (name === "tasks") return preferTask(theirs as TaskValue, ours as TaskValue);
  if (name === "executions") return preferExecution(theirs as ExecutionValue, ours as ExecutionValue);
  if (name === "knowledge") return theirs;
  return ours;
}

/** The file as it is now: a new identity after every write, whatever the clock says. */
export function storeFingerprint(path: string): string | undefined {
  try {
    const metadata = statSync(path);
    return `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Written beside the file and moved into place, so a reader never sees half of it. */
export function writeStoreState(path: string, state: StoreState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** A file that cannot be read is kept beside the store, not silently replaced. */
export function setAsideStore(path: string, now = Date.now()): boolean {
  try {
    let target = `${path}.unreadable-${now}`;
    for (let attempt = 2; exists(target) && attempt < 100; attempt += 1) {
      target = `${path}.unreadable-${now}-${attempt}`;
    }
    renameSync(path, target);
    return true;
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

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
