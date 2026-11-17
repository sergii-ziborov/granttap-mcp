import { createHash } from "node:crypto";
import type { PeerConfig } from "../../../../packages/core/relay-client";
import type { PairedPhoneEntry } from "../../../../packages/protocol/schema";
import { controllerPeerGate, pendingControllerOpen } from "../pairing/controllers";
import { hasControllerPresence, readControllerAddedAt, readControllerLastSeenAt, readControllerName,
  readPhoneLastSeenAt } from "../pairing/presence";

/** One first pairing plus sixteen added phones or iPads. */
export const EXTRA_PHONE_LIMIT = 16;
export const DAY_MS = 86_400_000;

/** A phone key as this computer knows it. `key` never leaves the computer. */
export type PhoneRecord = {
  key: string;
  id: string;
  label: string;
  name: string | null;
  primary: boolean;
  addedAt: number | null;
  lastSeenAt: number | null;
  /** Its QR is still open and not scanned yet. */
  pending: boolean;
};

export function phoneId(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

function primarySeenAt(key: string, legacySeenAt: number | null): number | null {
  // Before per-key presence existed, one time stood for "the phone".
  if (hasControllerPresence()) return readControllerLastSeenAt(key);
  return [legacySeenAt, readPhoneLastSeenAt()].reduce<number | null>((best, value) =>
    value != null && (best == null || value > best) ? value : best, null);
}

/**
 * Every phone key this computer accepts right now: the first pairing, then added phones in the order they
 * were added. An unscanned key whose QR expired is not accepted, so it is not listed.
 */
export function phoneRoster(machine: PeerConfig, options: { legacySeenAt?: number | null; now?: number } = {}): PhoneRecord[] {
  const now = options.now ?? Date.now();
  const allowed = controllerPeerGate(machine, () => now);
  const keys = [...new Set([machine.peerPublicKey, ...(machine.extraPeerPublicKeys ?? [])])]
    .filter((key, index) => key.length > 0 && (index === 0 || allowed(key)));
  return keys.map((key, index): PhoneRecord => {
    const id = phoneId(key);
    return {
      key, id, label: id.slice(0, 6), name: readControllerName(key), primary: index === 0,
      addedAt: readControllerAddedAt(key),
      lastSeenAt: index === 0 ? primarySeenAt(key, options.legacySeenAt ?? null) : readControllerLastSeenAt(key),
      pending: index > 0 && pendingControllerOpen(machine.room, key, now),
    };
  });
}

/** The later of when the phone last spoke and when it was added; null when neither is known. */
export function lastActivity(phone: PhoneRecord): number | null {
  const known = [phone.lastSeenAt, phone.addedAt].filter((value): value is number => value != null);
  return known.length ? Math.max(...known) : null;
}

/** Not heard from, and not added, within `days`. A phone whose QR is still open is never stale. */
export function idleFor(phone: PhoneRecord, days: number, now = Date.now()): boolean {
  if (phone.pending) return false;
  const at = lastActivity(phone);
  return at == null || now - at >= days * DAY_MS;
}

/**
 * The phone heard from most recently: the one in use, or the likeliest to be. Without any last-seen time the
 * latest activity decides, and among equals the earlier one in the roster (the first pairing first).
 */
export function mostRecentPhone(phones: readonly PhoneRecord[]): PhoneRecord | undefined {
  const rank = (phone: PhoneRecord): [number, number] => [phone.lastSeenAt ?? -1, lastActivity(phone) ?? -1];
  return phones.reduce<PhoneRecord | undefined>((best, phone) => {
    if (best === undefined) return phone;
    const [seen, active] = rank(phone), [bestSeen, bestActive] = rank(best);
    return seen > bestSeen || (seen === bestSeen && active > bestActive) ? phone : best;
  }, undefined);
}

/**
 * The phones a "not seen for `days`" removal takes: idle that long, and never the phone heard from most
 * recently, so the phone in use stays even when every phone has been away.
 */
export function stalePhones(phones: readonly PhoneRecord[], days: number, now = Date.now()): PhoneRecord[] {
  const latest = mostRecentPhone(phones);
  return phones.filter((phone) => phone !== latest && idleFor(phone, days, now));
}

/** The longest idle first; unknown counts as oldest, and among equals the earlier-added phone goes first. */
export function longestIdle(phones: readonly PhoneRecord[]): PhoneRecord | undefined {
  return phones.reduce<PhoneRecord | undefined>((oldest, phone) =>
    oldest === undefined || (lastActivity(phone) ?? -1) < (lastActivity(oldest) ?? -1) ? phone : oldest, undefined);
}

export function phoneEntries(phones: readonly PhoneRecord[], requester?: string): PairedPhoneEntry[] {
  return phones.map((phone) => ({
    id: phone.id, label: phone.label, ...(phone.name ? { name: phone.name } : {}),
    thisPhone: requester != null && phone.key === requester, primary: phone.primary,
    ...(phone.addedAt != null ? { addedAt: phone.addedAt } : {}),
    ...(phone.lastSeenAt != null ? { lastSeenAt: phone.lastSeenAt } : {}),
  }));
}
