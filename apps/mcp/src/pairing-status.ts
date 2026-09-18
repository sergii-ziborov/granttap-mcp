import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../bridge/src/config";
import { readPhoneLastSeenAt } from "../../bridge/src/presence";

export type PairedPhone = {
  name: string;
  status: "paired" | "seen";
  lastSeenAt: number | null;
};

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

/** One saved pairing slot on this Mac, not every device that knows the room. */
export function listPairedPhones(phoneLastSeenAt: number | null = null, now = Date.now()): PairedPhone[] {
  if (!isMachineConfigured()) return [];
  let name = "iPhone";
  try {
    const phonePath = join(dirname(readOnlyMachineConfigPath()), "phone.pairing.json");
    if (existsSync(phonePath)) {
      const labeled = loadConfig(phonePath).deviceName?.trim();
      if (labeled && labeled !== "phone") name = labeled.slice(0, 80);
    }
  } catch { /* keep iPhone */ }
  const recorded = readPhoneLastSeenAt();
  const lastSeenAt = [phoneLastSeenAt, recorded].reduce<number | null>((best, value) => (
    value != null && (best == null || value > best) ? value : best
  ), null);
  const seen = lastSeenAt != null && now - lastSeenAt < 60_000;
  return [{ name, status: seen ? "seen" : "paired", lastSeenAt }];
}
