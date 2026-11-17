import type { DeviceManagementRequest, PairedPhoneEntry } from "../../../../packages/protocol/schema";
import { PHONE_ACTIONS } from "../../../../packages/protocol/schema";
import { loadConfig, machineConfigPath } from "../config";
import { PhoneChangeRefused, removePhoneKeys } from "./removal";
import { idleFor, phoneEntries, phoneRoster, type PhoneRecord } from "./roster";

type PhoneAction = (typeof PHONE_ACTIONS)[number];

export type PhoneChangeOutcome = { message: string; removedPhoneIds: string[] };

export type PlannedPhoneChange = {
  /** The requesting phone removes itself: its answer, `selfOutcome`, must go out before its key does. */
  selfOutcome?: PhoneChangeOutcome;
  /** Writes the change and says what it did. */
  commit: () => PhoneChangeOutcome;
};

export function isPhoneAction(action: string): action is PhoneAction {
  return (PHONE_ACTIONS as readonly string[]).includes(action);
}

const phones = (count: number) => `${count} ${count === 1 ? "phone" : "phones"}`;

/** The phones listed in a status answer, with the phone that asked marked. */
export function phonesFor(requester: string, now = Date.now()): PairedPhoneEntry[] {
  return phoneEntries(phoneRoster(loadConfig(machineConfigPath()), { now }), requester);
}

function targetsFor(request: DeviceManagementRequest, roster: PhoneRecord[], self: PhoneRecord, now: number): PhoneRecord[] {
  if (request.action === "phones-unpair-self") {
    if (roster.length === 1) {
      throw new PhoneChangeRefused("This is the only phone paired with this computer, so it stays. Pair another phone first.");
    }
    return [self];
  }
  if (request.action === "phones-remove") {
    const ids = new Set(request.phoneIds ?? []);
    if (ids.has(self.id)) {
      throw new PhoneChangeRefused("The phone you are using is in the list. Use Unpair this phone to remove it.");
    }
    return roster.filter((phone) => ids.has(phone.id));
  }
  return roster.filter((phone) => phone !== self && idleFor(phone, request.notSeenForDays ?? Infinity, now));
}

/**
 * Check a phone's request against the pairing on disk. Nothing is written until `commit`, which repeats the
 * last-phone check under the pairing lock. A phone never removes itself except by `phones-unpair-self`.
 */
export function planPhoneChange(request: DeviceManagementRequest, requester: string, room: string,
  now = Date.now()): PlannedPhoneChange {
  const roster = phoneRoster(loadConfig(machineConfigPath()), { now });
  const self = roster.find((phone) => phone.key === requester);
  if (!self) throw new PhoneChangeRefused("This phone is no longer paired with this computer.");
  const targets = targetsFor(request, roster, self, now);
  const unpaired = { message: "This phone is no longer paired with this computer.", removedPhoneIds: [self.id] };
  return {
    ...(request.action === "phones-unpair-self" ? { selfOutcome: unpaired } : {}),
    commit: () => {
      const outcome = removePhoneKeys(room, targets.map((phone) => phone.key), now);
      const removedPhoneIds = outcome.removed.map((phone) => phone.id);
      if (request.action === "phones-unpair-self") return unpaired;
      if (removedPhoneIds.length === 0) {
        return { removedPhoneIds, message: request.action === "phones-remove-stale"
          ? `No other phone has been away for ${request.notSeenForDays} days.` : "Those phones were already removed." };
      }
      return { removedPhoneIds,
        message: `Removed ${phones(removedPhoneIds.length)}. ${phones(outcome.remaining)} stay paired with this computer.` };
    },
  };
}
