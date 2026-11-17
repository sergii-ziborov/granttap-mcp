/** A QR may authorize a new phone key only for its one-time enrollment window. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PeerConfig } from "../../../../packages/core/relay-client";
import { saveConfig } from "../config/access/pairing";
import { writePrivateFile } from "../config/access/write-private";
import { configDir, machineConfigPath } from "../config/runtime/paths";

type PendingController = { room: string; peerPublicKey: string; expiresAt: number };

function path(): string {
  return join(configDir(), "pending-controllers.json");
}

function loadStrict(): PendingController[] | null {
  try {
    const value = JSON.parse(readFileSync(path(), "utf8")) as unknown;
    if (!Array.isArray(value) || value.length > 16) return null;
    const valid = (item: unknown): item is PendingController => {
      if (!item || typeof item !== "object") return false;
      const record = item as Partial<PendingController>;
      return typeof record.room === "string" && record.room.length > 0
        && typeof record.peerPublicKey === "string" && record.peerPublicKey.length > 0
        && typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt);
    };
    return value.every(valid) ? value as PendingController[] : null;
  } catch {
    return null;
  }
}

function save(pending: PendingController[]): void {
  writePrivateFile(path(), `${JSON.stringify(pending)}\n`);
}

export function rememberPendingController(room: string, peerPublicKey: string, expiresAt: number): void {
  const loaded = loadStrict();
  if (loaded === null && existsSync(path())) throw new Error("controller enrollment journal is invalid");
  const pending = (loaded ?? []).filter((item) => item.room !== room || item.peerPublicKey !== peerPublicKey);
  save([...pending, { room, peerPublicKey, expiresAt }].slice(-16));
}

/** Authenticated activity from this exact key makes its grant durable. */
export function confirmPendingController(room: string, peerPublicKey: string, now = Date.now()): boolean {
  const pending = loadStrict();
  if (pending === null) return false;
  if (pending.some((item) => item.room === room && item.peerPublicKey === peerPublicKey
    && item.expiresAt <= now)) return false;
  const remaining = pending.filter((item) => item.room !== room || item.peerPublicKey !== peerPublicKey);
  if (remaining.length === pending.length) return false;
  save(remaining);
  return true;
}

function liveRoomConfig(config: PeerConfig): PeerConfig | null {
  try {
    const live = JSON.parse(readFileSync(machineConfigPath(), "utf8")) as PeerConfig;
    return live.room === config.room && live.myPublicKey === config.myPublicKey ? live : null;
  } catch { return null; }
}

/**
 * Every machine-side RelayClient uses this before parsing or sending a payload. The file is read on each
 * call, so a phone removed on disk stops receiving at once, the first pairing included: the primary this
 * process started with stays trusted until this room's file names another primary and no longer lists it.
 */
export function controllerPeerGate(config: PeerConfig, now = Date.now): (peerPublicKey: string) => boolean {
  return (peerPublicKey) => {
    if (config.role !== "machine") return true;
    const live = liveRoomConfig(config);
    if (!live) return peerPublicKey === config.peerPublicKey;
    if (peerPublicKey === live.peerPublicKey) return true;
    if (!live.extraPeerPublicKeys?.includes(peerPublicKey)) return false;
    const pending = loadStrict();
    if (pending === null) return false;
    const record = pending.find((item) => item.room === config.room && item.peerPublicKey === peerPublicKey);
    return record === undefined || record.expiresAt > now();
  };
}

/** A QR shown for this key is still open: its phone may not have scanned it yet. */
export function pendingControllerOpen(room: string, peerPublicKey: string, now = Date.now()): boolean {
  return loadStrict()?.some((item) => item.room === room && item.peerPublicKey === peerPublicKey
    && item.expiresAt > now) === true;
}

/** Removed keys leave the enrollment journal too; the journal itself stays, so extras remain verifiable. */
export function forgetPendingControllers(room: string, peerPublicKeys: readonly string[]): void {
  const pending = loadStrict();
  if (pending === null) return;
  const remaining = pending.filter((item) => item.room !== room || !peerPublicKeys.includes(item.peerPublicKey));
  if (remaining.length !== pending.length) save(remaining);
}

/** Expired, unclaimed QR keys cannot consume every controller slot forever. */
export function prunePendingControllers(config: PeerConfig, now = Date.now()): PeerConfig {
  const pending = loadStrict();
  if (pending === null) {
    if ((config.extraPeerPublicKeys?.length ?? 0) === 0) return config;
    const next = { ...config, extraPeerPublicKeys: [] };
    saveConfig(machineConfigPath(), next);
    save([]);
    return next;
  }
  const expired = new Set(pending.filter((item) =>
    item.room === config.room && item.expiresAt <= now).map((item) => item.peerPublicKey));
  if (expired.size === 0) return config;
  const extra = (config.extraPeerPublicKeys ?? []).filter((key) => !expired.has(key));
  const next = { ...config, extraPeerPublicKeys: extra };
  // Revoke the old public keys first. A crash before the journal update can
  // safely retry; the reverse order would leave an untracked authorized key.
  saveConfig(machineConfigPath(), next);
  save(pending.filter((item) => item.room !== config.room || item.expiresAt > now));
  return next;
}
