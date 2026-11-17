import { withStoreLock } from "../../../../packages/core/store-file-lock";
import { loadConfig, machineConfigPath, saveConfig } from "../config";
import { forgetPendingControllers } from "../pairing/controllers";
import { forgetControllers } from "../pairing/presence";
import { lastActivity, phoneRoster, type PhoneRecord } from "./roster";

/** A refusal the person can act on; its message is shown as it is. */
export class PhoneChangeRefused extends Error {}

export const LAST_PHONE = "At least one phone must stay paired with this computer.";

export type PhoneRemoval = { removed: PhoneRecord[]; remaining: number; promoted?: PhoneRecord };

/** The phone to take the first pairing's place: one already scanned, the most recently heard from. */
function successor(phones: readonly PhoneRecord[]): PhoneRecord {
  const scanned = phones.filter((phone) => !phone.pending);
  const pool = scanned.length ? scanned : phones;
  const seen = (phone: PhoneRecord) => phone.lastSeenAt ?? lastActivity(phone) ?? -1;
  return pool.reduce((best, phone) => seen(phone) > seen(best) ? phone : best);
}

/**
 * Remove phone keys from this computer's pairing in one locked, atomic write. Every relay link rereads the
 * file before each send, so a removed phone stops receiving at once. Removing the first pairing hands its
 * place to the remaining phone heard from most recently. Keys that are already gone are skipped.
 */
export function removePhoneKeys(room: string, keys: readonly string[], now = Date.now()): PhoneRemoval {
  return withStoreLock(machineConfigPath(), () => {
    const machine = loadConfig(machineConfigPath());
    if (machine.role !== "machine" || machine.room !== room) {
      throw new PhoneChangeRefused("This computer's pairing changed. Refresh and try again.");
    }
    const phones = phoneRoster(machine, { now });
    const removed = phones.filter((phone) => keys.includes(phone.key));
    const kept = phones.filter((phone) => !keys.includes(phone.key));
    if (removed.length === 0) return { removed, remaining: phones.length };
    if (kept.length === 0) throw new PhoneChangeRefused(LAST_PHONE);
    const gone = removed.map((phone) => phone.key);
    const promoted = gone.includes(machine.peerPublicKey) ? successor(kept) : undefined;
    const primary = promoted?.key ?? machine.peerPublicKey;
    // Revoke first: a crash after this write leaves only journal and presence entries that name no phone.
    saveConfig(machineConfigPath(), { ...machine, peerPublicKey: primary,
      extraPeerPublicKeys: (machine.extraPeerPublicKeys ?? []).filter((key) => !gone.includes(key) && key !== primary) });
    forgetPendingControllers(room, gone);
    forgetControllers(gone);
    return { removed, remaining: kept.length, ...(promoted ? { promoted: { ...promoted, primary: true } } : {}) };
  });
}
