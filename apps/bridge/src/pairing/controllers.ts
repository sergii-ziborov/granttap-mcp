/** A QR may authorize a new phone key only for its one-time enrollment window. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PeerConfig } from "../../../../packages/core/relay-client";
import { saveConfig } from "../config/access/pairing";
import { writePrivateFile } from "../config/access/write-private";
import { configDir, machineConfigPath } from "../config/runtime/paths";

type PendingController = { room: string; peerPublicKey: string; expiresAt: number };

function path(): string {
  return join(configDir(), "pending-controllers.json");
}

function load(): PendingController[] {
  try {
    const value = JSON.parse(readFileSync(path(), "utf8")) as unknown;
    if (!Array.isArray(value)) return [];
    return value.slice(0, 16).filter((item): item is PendingController => {
      if (!item || typeof item !== "object") return false;
      const record = item as Partial<PendingController>;
      return typeof record.room === "string" && record.room.length > 0
        && typeof record.peerPublicKey === "string" && record.peerPublicKey.length > 0
        && typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt);
    });
  } catch {
    return [];
  }
}

function save(pending: PendingController[]): void {
  writePrivateFile(path(), `${JSON.stringify(pending)}\n`);
}

export function rememberPendingController(room: string, peerPublicKey: string, expiresAt: number): void {
  const pending = load().filter((item) => item.room !== room || item.peerPublicKey !== peerPublicKey);
  save([...pending, { room, peerPublicKey, expiresAt }].slice(-16));
}

/** Authenticated activity from this exact key makes its grant durable. */
export function confirmPendingController(room: string, peerPublicKey: string): boolean {
  const pending = load();
  const remaining = pending.filter((item) => item.room !== room || item.peerPublicKey !== peerPublicKey);
  if (remaining.length === pending.length) return false;
  save(remaining);
  return true;
}

/** Expired, unclaimed QR keys cannot consume every controller slot forever. */
export function prunePendingControllers(config: PeerConfig, now = Date.now()): PeerConfig {
  const pending = load();
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
