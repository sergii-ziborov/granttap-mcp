import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../config/runtime/paths";
import { writePrivateFile } from "../config/access/write-private";

type PresenceState = {
  phoneLastSeenAt?: number;
  controllers?: Record<string, number>;
  names?: Record<string, string>;
};

function presencePath(): string {
  return join(configDir(), "presence.json");
}

function readPresence(): PresenceState {
  try {
    const parsed = JSON.parse(readFileSync(presencePath(), "utf8")) as PresenceState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Last encrypted phone payload observed on this computer. No secrets. */
export function readPhoneLastSeenAt(): number | null {
  const at = readPresence().phoneLastSeenAt;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function readControllerLastSeenAt(peerPublicKey: string): number | null {
  const at = readPresence().controllers?.[peerPublicKey];
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function readControllerName(peerPublicKey: string): string | null {
  const name = readPresence().names?.[peerPublicKey];
  return typeof name === "string" && name.length > 0 && name.length <= 80
    && !/^(phone|machine|iphone|ipad)$/i.test(name) ? name : null;
}

/** A controller chooses its own visible label; never infer it from a pairing role. */
export function recordControllerName(peerPublicKey: string, value: string): boolean {
  const name = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(peerPublicKey)
    || !name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)
    || /^(phone|machine|iphone|ipad)$/i.test(name)) return false;
  const previous = readPresence();
  const names = { ...previous.names, [peerPublicKey]: name };
  const bounded = Object.fromEntries(Object.entries(names).slice(-32));
  writePrivateFile(presencePath(), JSON.stringify({ ...previous, names: bounded }));
  return true;
}

export function hasControllerPresence(): boolean {
  return Object.keys(readPresence().controllers ?? {}).length > 0;
}

export function recordPhoneSeen(at = Date.now(), peerPublicKey?: string): void {
  const path = presencePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const previous = readPresence();
  writeFileSync(tmp, JSON.stringify({ ...previous, phoneLastSeenAt: at,
    controllers: peerPublicKey
      ? { ...previous.controllers, [peerPublicKey]: at }
      : previous.controllers,
  }), { mode: 0o600 });
  renameSync(tmp, path);
}

export function clearPhoneSeen(): void {
  try {
    unlinkSync(presencePath());
  } catch {
    /* nothing stored */
  }
}
