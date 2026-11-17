import type { PeerConfig } from "../../../../packages/core/relay-client";
import { withStoreLock } from "../../../../packages/core/store-file-lock";
import { loadConfig, machineConfigPath, saveConfig } from "../config";
import { forgetPendingControllers, prunePendingControllers, rememberPendingController } from "../pairing/controllers";
import { forgetControllers, recordControllerAdded } from "../pairing/presence";
import { EXTRA_PHONE_LIMIT, idleFor, longestIdle, phoneRoster, type PhoneRecord } from "./roster";

/** An added phone not heard from, and not added, for this long may give its place to a new phone. */
export const EVICTION_IDLE_DAYS = 30;

export const PHONE_LIMIT_REACHED = `This computer already has ${EXTRA_PHONE_LIMIT + 1} phones, and each was used in the `
  + `last ${EVICTION_IDLE_DAYS} days. Remove one in GrantTap → Devices → this computer → Phones, then add the new phone.`;

/**
 * At the limit, the added phone that has been idle longest gives its place to the new one, but only when it
 * has been idle for at least EVICTION_IDLE_DAYS. The first pairing, a phone heard from or added within that
 * time, and a key whose QR is still open are never taken. Returns null when there is room; throws when every
 * place is in use.
 */
export function evictionFor(machine: PeerConfig, now = Date.now()): PhoneRecord | null {
  const added = phoneRoster(machine, { now }).filter((phone) => !phone.primary);
  if (added.length < EXTRA_PHONE_LIMIT) return null;
  const victim = longestIdle(added.filter((phone) => idleFor(phone, EVICTION_IDLE_DAYS, now)));
  if (!victim) throw new Error(PHONE_LIMIT_REACHED);
  return victim;
}

/**
 * Authorize one more phone key on the pairing as it is on disk now, not as it was when the QR was made, so a
 * phone removed meanwhile stays removed. The key is journaled before it is authorized, as before.
 */
export function admitPhoneKey(room: string, publicKey: string, expiresAt: number, now = Date.now()): PeerConfig {
  return withStoreLock(machineConfigPath(), () => {
    const machine = prunePendingControllers(loadConfig(machineConfigPath()), now);
    if (machine.role !== "machine" || machine.room !== room) {
      throw new Error("This computer's pairing room changed while the phone code was being created.");
    }
    if (machine.peerPublicKey === publicKey) return machine;
    const evicted = (machine.extraPeerPublicKeys ?? []).includes(publicKey) ? null : evictionFor(machine, now);
    rememberPendingController(room, publicKey, expiresAt);
    const extra = (machine.extraPeerPublicKeys ?? []).filter((key) => key !== evicted?.key && key !== publicKey);
    const next = { ...machine, extraPeerPublicKeys: [...extra, publicKey] };
    saveConfig(machineConfigPath(), next);
    recordControllerAdded(publicKey, now);
    if (evicted) {
      forgetPendingControllers(room, [evicted.key]);
      forgetControllers([evicted.key]);
      const idle = evicted.lastSeenAt == null ? "never seen" : `last seen ${new Date(evicted.lastSeenAt).toISOString()}`;
      process.stderr.write(`[pairing] phone limit reached: phone ${evicted.label} (${idle}) gave its place to a new phone\n`);
    }
    return next;
  });
}
