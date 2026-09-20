import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  const overridden = process.env.GRANTTAP_CONFIG_DIR ?? process.env.NODVOX_CONFIG_DIR;
  if (overridden) return overridden;

  const current = join(homedir(), ".granttap");
  const legacy = join(homedir(), ".nodvox");
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current);
    } catch {
      return legacy;
    }
  }
  return current;
}

export function machineConfigPath(): string {
  return join(configDir(), "machine.json");
}

export function runtimeConfigPath(): string {
  return join(configDir(), "config.json");
}

export function phonePairingPath(): string {
  return join(configDir(), "phone.pairing.json");
}
