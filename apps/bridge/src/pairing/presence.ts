import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config/runtime/paths";
import { writePrivateFile } from "../config/access/write-private";

type PresenceState = {
  phoneLastSeenAt?: number;
  controllers?: Record<string, number>;
  names?: Record<string, string>;
  /** When this computer authorized each phone key; unknown for keys added before this was recorded. */
  added?: Record<string, number>;
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

export function readControllerAddedAt(peerPublicKey: string): number | null {
  const at = readPresence().added?.[peerPublicKey];
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

/** Remember when a phone key was authorized, so a phone that has not spoken yet is not taken for an old one. */
export function recordControllerAdded(peerPublicKey: string, at = Date.now()): void {
  const previous = readPresence();
  const added = Object.fromEntries(Object.entries({ ...previous.added, [peerPublicKey]: at }).slice(-32));
  writePrivateFile(presencePath(), JSON.stringify({ ...previous, added }));
}

/** A removed phone leaves no name, time or activity behind. */
export function forgetControllers(peerPublicKeys: readonly string[]): void {
  if (peerPublicKeys.length === 0) return;
  const previous = readPresence();
  const without = <T>(map: Record<string, T> | undefined) => map
    && Object.fromEntries(Object.entries(map).filter(([key]) => !peerPublicKeys.includes(key)));
  writePrivateFile(presencePath(), JSON.stringify({ ...previous, controllers: without(previous.controllers),
    names: without(previous.names), added: without(previous.added) }));
}

export function hasControllerPresence(): boolean {
  return Object.keys(readPresence().controllers ?? {}).length > 0;
}

const SEEN_WRITE_INTERVAL_MS = 5_000;
const lastSeenWrites = new Map<string, number>();

/**
 * Remember the last encrypted phone payload. The monitor and every MCP server in an open chat write this
 * file; a shared temporary name let one process rename another's file away, and the ENOENT that followed
 * dropped the phone's request (chat events, subscriptions, pictures, settings, device management). The
 * write now uses its own temporary file, happens at most every few seconds per phone, and never throws:
 * presence is advisory and must not cost the phone its answer.
 */
export function recordPhoneSeen(at = Date.now(), peerPublicKey?: string): boolean {
  const key = peerPublicKey ?? "";
  const last = lastSeenWrites.get(key);
  if (last !== undefined && at >= last && at - last < SEEN_WRITE_INTERVAL_MS) return true;
  try {
    const previous = readPresence();
    writePrivateFile(presencePath(), JSON.stringify({ ...previous, phoneLastSeenAt: at,
      controllers: peerPublicKey
        ? { ...previous.controllers, [peerPublicKey]: at }
        : previous.controllers,
    }));
    lastSeenWrites.set(key, at);
    return true;
  } catch {
    return false;
  }
}

/** Tests start each case from a clean throttle. */
export function resetPhoneSeenThrottle(): void {
  lastSeenWrites.clear();
}

export function clearPhoneSeen(): void {
  try {
    unlinkSync(presencePath());
  } catch {
    /* nothing stored */
  }
}
