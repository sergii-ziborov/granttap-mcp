import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../../bridge/src/config";
import { DAY_MS, idleFor, phoneRoster } from "../../../bridge/src/paired-phones";

export type PairedPhone = {
  /** sha256 of the phone key, hex; what `remove_phones` takes. `label` is its first six characters. */
  id: string;
  label: string;
  name: string;
  /** The first pairing on this computer. */
  primary: boolean;
  status: "paired" | "seen";
  lastSeenAt: number | null;
  addedAt: number | null;
};

/** What a page outside this computer's own MCP tools is shown about a phone. */
export type PhonePresence = Pick<PairedPhone, "name" | "status" | "lastSeenAt">;

export type PhoneReachability = "live" | "offline" | "unknown";

/** healthz must not stay "unknown" when this Mac already has a pairing slot. */
export function phoneReachability(phones: readonly PhonePresence[] = listPairedPhones()): PhoneReachability {
  if (phones.length === 0) return "unknown";
  return phones.some((phone) => phone.status === "seen") ? "live" : "offline";
}

/** Resolve the active config without configDir()'s legacy rename side effect. */
export function readOnlyMachineConfigPath(): string {
  const overridden = process.env.GRANTTAP_CONFIG_DIR ?? process.env.NODVOX_CONFIG_DIR;
  if (overridden) return join(overridden, "machine.json");
  const current = join(homedir(), ".granttap");
  const legacy = join(homedir(), ".nodvox");
  return join(!existsSync(current) && existsSync(legacy) ? legacy : current, "machine.json");
}

/** True when ~/.granttap/machine.json exists with complete local pairing keys. */
export function isMachineConfigured(): boolean {
  const path = readOnlyMachineConfigPath();
  if (!existsSync(path)) return false;
  try {
    const cfg = loadConfig(path);
    return Boolean(cfg.mySecretKey && cfg.peerPublicKey && cfg.room && cfg.relayUrl);
  } catch {
    return false;
  }
}

function parkedPhoneName(machinePath: string, primaryKey: string): string | null {
  try {
    const phonePath = join(dirname(machinePath), "phone.pairing.json");
    if (!existsSync(phonePath)) return null;
    const parked = loadConfig(phonePath);
    const labeled = parked.deviceName?.trim();
    return parked.myPublicKey === primaryKey && labeled && labeled !== "phone" ? labeled.slice(0, 80) : null;
  } catch { return null; }
}

/** Authorized controller keys for this computer; activity is per authenticated key. */
export function listPairedPhones(phoneLastSeenAt: number | null = null, now = Date.now()): PairedPhone[] {
  if (!isMachineConfigured()) return [];
  const machine = loadConfig(readOnlyMachineConfigPath());
  return phoneRoster(machine, { legacySeenAt: phoneLastSeenAt, now }).map((phone, index): PairedPhone => ({
    id: phone.id, label: phone.label, primary: phone.primary,
    name: phone.name ?? (phone.primary
      ? parkedPhoneName(readOnlyMachineConfigPath(), phone.key) ?? "iPhone"
      : `Controller ${index + 1} · ${phone.label}`),
    status: phone.lastSeenAt != null && now - phone.lastSeenAt < 60_000 ? "seen" : "paired",
    lastSeenAt: phone.lastSeenAt, addedAt: phone.addedAt,
  }));
}

const RECENT_MS = 7 * DAY_MS;
/** The idle time after which connection_status suggests `remove_phones`, as the phone's own action does. */
export const STALE_PHONE_DAYS = 30;

function age(at: number | null, now: number): string {
  if (at == null) return "never seen";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `last seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `last seen ${hours} h ago` : `last seen ${Math.round(hours / 24)} days ago`;
}

/**
 * The paired phones by how recently each spoke to this computer, one line each. Keys stay paired until
 * someone removes them, so test installs and deleted apps pile up; this tells the ones in use from the rest.
 */
export function phoneSummary(phones: PairedPhone[], now = Date.now()): string | undefined {
  if (phones.length === 0) return undefined;
  const seen = phones.filter((phone) => phone.status === "seen").length;
  const recent = phones.filter((phone) => phone.status !== "seen" && phone.lastSeenAt != null
    && now - phone.lastSeenAt < RECENT_MS).length;
  const rest = phones.length - seen - recent;
  const stale = phones.filter((phone) => idleFor({ ...phone, key: "", pending: false }, STALE_PHONE_DAYS, now)).length;
  const lines = phones.map((phone) => `- ${phone.name}${phone.primary ? " (first pairing)" : ""} · id ${phone.label} · `
    + age(phone.lastSeenAt, now));
  return [`Paired phones: ${phones.length} — ${seen} active in the last minute, ${recent} more seen in the last 7 days, `
    + `${rest} not seen for 7 days or never.`, ...lines,
  ...(stale > 0 && stale < phones.length
    ? [`${stale} not seen for ${STALE_PHONE_DAYS} days or never; remove_phones asks the person on a phone to remove them.`]
    : [])].join("\n");
}
