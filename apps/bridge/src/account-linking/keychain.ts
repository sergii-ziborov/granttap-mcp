import { spawnSync } from "node:child_process";
import type { SecretVault } from "./contracts";

const SERVICE = "com.granttap.machine-account";

export class MacKeychainVault implements SecretVault {
  load(account: string): string | null {
    const result = spawnSync("security", [
      "find-generic-password", "-a", account, "-s", SERVICE, "-w",
    ], { encoding: "utf8", maxBuffer: 32_768 });
    if (result.status === 44) return null;
    if (result.status !== 0) throw new Error("GrantTap could not read protected account storage");
    return result.stdout.replace(/\r?\n$/, "");
  }

  save(account: string, value: string): void {
    const result = spawnSync("security", [
      "add-generic-password", "-U", "-a", account, "-s", SERVICE, "-w",
    ], { input: `${value}\n`, encoding: "utf8", maxBuffer: 32_768 });
    if (result.status !== 0) throw new Error("GrantTap could not save protected account storage");
  }

  remove(account: string): void {
    const result = spawnSync("security", [
      "delete-generic-password", "-a", account, "-s", SERVICE,
    ], { encoding: "utf8", maxBuffer: 32_768 });
    if (result.status !== 0 && result.status !== 44) throw new Error("GrantTap could not clear protected account storage");
  }
}

export function protectedVault(): SecretVault {
  if (process.platform !== "darwin") {
    throw new Error("protected GrantTap account storage is not available on this platform yet");
  }
  return new MacKeychainVault();
}
