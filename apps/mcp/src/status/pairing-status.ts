import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../../bridge/src/config";
import { hasControllerPresence, readControllerLastSeenAt, readPhoneLastSeenAt } from "../../../bridge/src/pairing/presence";

export type PairedPhone = {
  name: string;
  status: "paired" | "seen";
  lastSeenAt: number | null;
};

export type PhoneReachability = "live" | "offline" | "unknown";

/** healthz must not stay "unknown" when this Mac already has a pairing slot. */
export function phoneReachability(phones: PairedPhone[] = listPairedPhones()): PhoneReachability {
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

/** Authorized controller keys for this computer; activity is per authenticated key. */
export function listPairedPhones(phoneLastSeenAt: number | null = null, now = Date.now()): PairedPhone[] {
  if (!isMachineConfigured()) return [];
  const machine = loadConfig(readOnlyMachineConfigPath());
  let name = "iPhone";
  try {
    const phonePath = join(dirname(readOnlyMachineConfigPath()), "phone.pairing.json");
    if (existsSync(phonePath)) {
      const labeled = loadConfig(phonePath).deviceName?.trim();
      if (labeled && labeled !== "phone") name = labeled.slice(0, 80);
    }
  } catch { /* keep iPhone */ }
  const primarySeen = readControllerLastSeenAt(machine.peerPublicKey);
  const recorded = hasControllerPresence() ? primarySeen : readPhoneLastSeenAt();
  const lastSeenAt = [hasControllerPresence() ? null : phoneLastSeenAt, recorded].reduce<number | null>((best, value) => (
    value != null && (best == null || value > best) ? value : best
  ), null);
  const seen = lastSeenAt != null && now - lastSeenAt < 60_000;
  const primary: PairedPhone = { name, status: seen ? "seen" : "paired", lastSeenAt };
  const additional = (machine.extraPeerPublicKeys ?? [])
    .filter((key) => key && key !== machine.peerPublicKey)
    .map((key, index): PairedPhone => {
      const at = readControllerLastSeenAt(key);
      const suffix = createHash("sha256").update(key).digest("hex").slice(0, 6);
      return { name: `Controller ${index + 2} · ${suffix}`,
        status: at != null && now - at < 60_000 ? "seen" : "paired", lastSeenAt: at };
    });
  return [primary, ...additional];
}
