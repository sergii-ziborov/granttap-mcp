import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../bridge/src/config";

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
