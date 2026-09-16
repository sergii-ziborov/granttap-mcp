import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function isCursorHelperNode(nodePath: string): boolean {
  const normalized = nodePath.replaceAll("\\", "/");
  return /Cursor\.app|[\\/]Cursor[\\/].*[\\/]helpers[\\/]node/i.test(normalized)
    || normalized.toLowerCase().includes("/helpers/node");
}

/** Absolute Node for scheduled jobs — never Cursor's helper node. */
export function resolveMonitorNodeBin(): string | null {
  const home = homedir();
  const pinnedUnix = join(home, ".nvm", "versions", "node", "v22.13.1", "bin", "node");
  const envNode = process.env.GRANTTAP_NODE?.trim();
  const nvmName = process.platform === "win32" ? "node.exe" : "node";
  const nvmBin = process.env.NVM_BIN ? join(process.env.NVM_BIN, nvmName) : "";
  const programFiles = process.platform === "win32"
    ? [
      process.env.ProgramFiles ? join(process.env.ProgramFiles, "nodejs", "node.exe") : "",
      process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe") : "",
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe") : "",
    ]
    : [];
  const candidates = [envNode, ...locateNodeOnPath(), ...programFiles, nvmBin, process.execPath, pinnedUnix];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (isCursorHelperNode(candidate)) continue;
    return candidate;
  }
  return existsSync(pinnedUnix) ? pinnedUnix : null;
}

function locateNodeOnPath(): string[] {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, ["node"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
