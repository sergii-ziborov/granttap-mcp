import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  httpMcpLaunchAgentPath,
  isConfiguredHttpService,
  isHttpMcpServiceLoaded,
  isOwnedHttpService,
} from "./common";

export type HttpMcpServiceStatus = { configured: boolean; running: boolean };

export type HttpMcpServiceSnapshot = {
  path: string;
  exists: boolean;
  plist: Buffer | null;
  mode: number;
  owned: boolean;
  configured: boolean;
  running: boolean;
};

/** Exact plist bytes/mode and loaded state for transactional repair rollback. */
export function snapshotHttpMcpService(): HttpMcpServiceSnapshot {
  const path = httpMcpLaunchAgentPath();
  if (!existsSync(path)) return missingSnapshot(path);
  let plist: Buffer;
  try {
    plist = readFileSync(path);
  } catch {
    return unreadableSnapshot(path);
  }
  const contents = plist.toString("utf8");
  const owned = isOwnedHttpService(contents);
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    // Content is still safe to restore with the LaunchAgent default mode.
  }
  return {
    path, exists: true, plist, mode, owned,
    configured: owned && isConfiguredHttpService(contents),
    running: owned && isHttpMcpServiceLoaded(),
  };
}

function missingSnapshot(path: string): HttpMcpServiceSnapshot {
  return { path, exists: false, plist: null, mode: 0o644, owned: false, configured: false, running: false };
}

function unreadableSnapshot(path: string): HttpMcpServiceSnapshot {
  return { path, exists: true, plist: null, mode: 0o644, owned: false, configured: false, running: false };
}

/** Read-only plist/process inspection. Health is probed separately. */
export function inspectHttpMcpService(): HttpMcpServiceStatus {
  if (process.platform !== "darwin") return { configured: false, running: false };
  const snapshot = snapshotHttpMcpService();
  return { configured: snapshot.configured, running: snapshot.configured && snapshot.running };
}

/** Restore a failed repair, deleting the service only when this attempt created it. */
export function restoreHttpMcpServiceAfterFailure(before: HttpMcpServiceSnapshot): boolean {
  if (before.exists && !before.owned) return false;
  const current = currentOwnedPlist(before.path);
  if (current === undefined) return false;
  const currentlyLoaded = isHttpMcpServiceLoaded();
  if (current && before.plist?.equals(current) && before.running === currentlyLoaded) return false;
  bootout(before.path);
  if (!before.exists) return removeNewPlist(before.path, current);
  if (!before.plist) return false;
  restorePlist(before, before.plist);
  return !before.running || bootstrap(before.path);
}

function currentOwnedPlist(path: string): Buffer | null | undefined {
  if (!existsSync(path)) return null;
  let plist: Buffer;
  try {
    plist = readFileSync(path);
  } catch {
    return undefined;
  }
  return isOwnedHttpService(plist.toString("utf8")) ? plist : undefined;
}

function bootout(path: string): void {
  if (process.env.GRANTTAP_SKIP_LAUNCHCTL === "1") return;
  const uid = process.getuid?.();
  if (uid != null) spawnSync("launchctl", ["bootout", `gui/${uid}`, path], { stdio: "ignore" });
}

function removeNewPlist(path: string, current: Buffer | null): boolean {
  if (current) unlinkSync(path);
  return current != null;
}

function restorePlist(before: HttpMcpServiceSnapshot, plist: Buffer): void {
  mkdirSync(dirname(before.path), { recursive: true });
  const temporary = `${before.path}.${process.pid}.restore.tmp`;
  try {
    writeFileSync(temporary, plist, { mode: before.mode });
    chmodSync(temporary, before.mode);
    renameSync(temporary, before.path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function bootstrap(path: string): boolean {
  if (process.env.GRANTTAP_SKIP_LAUNCHCTL === "1") return true;
  const uid = process.getuid?.();
  if (uid == null) return false;
  return spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path], { stdio: "ignore" }).status === 0;
}
