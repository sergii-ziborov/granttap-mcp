import { loadConfig, machineConfigPath } from "../../../../bridge/src/config";
import { PhoneChangeRefused, phoneRoster, removePhoneKeys, stalePhones, type PhoneRecord }
  from "../../../../bridge/src/paired-phones";
import { listPairedPhones } from "../../status/pairing-status";
import type { YesNoOutcome } from "../connect/relay";
import { answered, refused, type ToolAnswer } from "../interaction/answers";

export type PhoneSelection = { phoneIds?: string[]; notSeenForDays?: number };
export type Consent = { outcome: YesNoOutcome; answeredBy?: string };
export type RemovalDeps = {
  room: string;
  computer: string;
  /** Asks the person yes or no on a phone; `answeredBy` is the key of the phone that answered. */
  ask: (question: string) => Promise<Consent>;
  now?: () => number;
};

type Shown = { id: string; label: string; name: string; lastSeenAt: number | null };

function shown(phones: readonly PhoneRecord[], now: number): Shown[] {
  const names = new Map(listPairedPhones(null, now).map((phone) => [phone.id, phone.name]));
  return phones.map((phone) => ({ id: phone.id, label: phone.label, name: names.get(phone.id) ?? phone.label,
    lastSeenAt: phone.lastSeenAt }));
}

/** The phones a selection names. An id may be shortened to its first six characters when that stays unique. */
export function selectPhones(roster: readonly PhoneRecord[], selection: PhoneSelection, now: number):
  { targets: PhoneRecord[] } | { error: string } {
  if (selection.phoneIds == null && selection.notSeenForDays == null) {
    return { error: "Name the phones: notSeenForDays, phoneIds from connection_status, or both." };
  }
  let targets = [...roster];
  if (selection.phoneIds != null) {
    const picked = new Set<PhoneRecord>();
    for (const id of selection.phoneIds) {
      const matches = roster.filter((phone) => phone.id.startsWith(id.toLowerCase()));
      if (matches.length !== 1) {
        return { error: matches.length === 0 ? `No phone paired with this computer has id ${id}. Read connection_status again.`
          : `Phone id ${id} matches ${matches.length} phones; give more of the id.` };
      }
      picked.add(matches[0]!);
    }
    targets = targets.filter((phone) => picked.has(phone));
  }
  if (selection.notSeenForDays != null) {
    // Never the phone heard from most recently: the one in use stays even when every phone has been away.
    const stale = new Set(stalePhones(roster, selection.notSeenForDays, now));
    targets = targets.filter((phone) => stale.has(phone));
  }
  if (targets.length > 0 && targets.length === roster.length) {
    return { error: `That is every phone paired with this computer (${roster.length}). The phone that answers always stays, `
      + "so leave at least one phone out." };
  }
  return { targets };
}

function age(at: number | null, now: number): string {
  if (at == null) return "never seen";
  const days = Math.floor((now - at) / 86_400_000);
  return days < 1 ? "seen today" : `last seen ${days} ${days === 1 ? "day" : "days"} ago`;
}

function question(phones: readonly Shown[], computer: string, now: number): string {
  const count = `${phones.length} ${phones.length === 1 ? "phone" : "phones"}`;
  const lines = phones.map((phone) => `• ${phone.name}${phone.name.includes(phone.label) ? "" : ` · ${phone.label}`}`
    + ` · ${age(phone.lastSeenAt, now)}`);
  return [`Remove ${count} from ${computer}? A removed phone stops receiving from this computer at once and needs a new `
    + "QR to pair again. The phone you answer on stays.", ...lines].join("\n").slice(0, 2_000);
}

function outcome(status: string, removed: Shown[], kept: Array<Shown & { reason: string }>, remaining: number) {
  return { status, removed, kept, remaining };
}

/**
 * Remove phones only after the person says yes on a phone. The phone that answered, any phone heard from
 * while the question was open, and the last phone stay; everything is checked again after the answer.
 */
export async function removePhonesWithConsent(selection: PhoneSelection, deps: RemovalDeps): Promise<ToolAnswer> {
  const now = deps.now ?? Date.now;
  const machine = loadConfig(machineConfigPath());
  if (machine.room !== deps.room) return refused("This computer's pairing changed. Read connection_status again.");
  const roster = phoneRoster(machine, { now: now() });
  const picked = selectPhones(roster, selection, now());
  if ("error" in picked) return refused(picked.error);
  if (picked.targets.length === 0) {
    return answered("No paired phone matches; nothing was asked or removed.", outcome("nothing_to_remove", [], [], roster.length));
  }
  const askedAt = now();
  const consent = await deps.ask(question(shown(picked.targets, askedAt), deps.computer, askedAt));
  if (consent.outcome.status === "timed_out") {
    return answered("Nobody answered on a phone, so nothing was removed. A timeout is not a yes.",
      outcome("timed_out", [], [], roster.length));
  }
  if (consent.outcome.decision === "no") {
    return answered("The person said no on the phone; nothing was removed.", outcome("declined", [], [], roster.length));
  }
  const current = phoneRoster(loadConfig(machineConfigPath()), { now: now() })
    .filter((phone) => picked.targets.some((target) => target.key === phone.key));
  const reason = (phone: PhoneRecord) => phone.key === consent.answeredBy ? "the person answered on this phone"
    : phone.lastSeenAt != null && phone.lastSeenAt >= askedAt ? "it reached this computer while the question was open" : null;
  // Named before the removal: a removed phone is no longer listed.
  const named = new Map(shown(current, now()).map((phone) => [phone.id, phone]));
  const kept = current.filter((phone) => reason(phone) != null)
    .map((phone) => ({ ...named.get(phone.id)!, reason: reason(phone)! }));
  try {
    const done = removePhoneKeys(deps.room, current.filter((phone) => reason(phone) == null).map((phone) => phone.key), now());
    const removed = done.removed.map((phone) => named.get(phone.id)!);
    const text = [`Removed ${removed.length} ${removed.length === 1 ? "phone" : "phones"}; ${done.remaining} stay paired.`,
      ...kept.map((phone) => `Kept ${phone.name} (${phone.label}): ${phone.reason}.`)].join("\n");
    return answered(text, outcome("removed", removed, kept, done.remaining));
  } catch (error) {
    if (error instanceof PhoneChangeRefused) return refused(error.message);
    throw error;
  }
}
