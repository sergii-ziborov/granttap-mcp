import { mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../config";

/** User Codex hooks run outside the plugin PATH, including apps started from the Dock. */
export function hookNodeCommand(route: string, nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform): string {
  if (route !== "codex" && route !== "codex-policy") return "node";
  const escaped = platform === "win32" ? nodePath.replaceAll('"', '""')
    : nodePath.replace(/["\\$`]/g, "\\$&");
  return `"${escaped}"`;
}

function currentTarget(link: string): string | undefined {
  try { return readlinkSync(link); } catch { return undefined; }
}

/**
 * Coding apps started from the Dock inherit a PATH without nvm and similar
 * version managers, so a plugin's `node` command may not resolve there. The
 * monitor always runs under a working Node and publishes it at one stable path.
 * Windows installs Node on PATH and needs no link.
 */
export function publishStableNode(root = configDir(), nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  const bin = join(root, "bin");
  const link = join(bin, "node");
  try {
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    if (currentTarget(link) === nodePath) return;
    const next = `${link}.${process.pid}.tmp`;
    rmSync(next, { force: true });
    symlinkSync(nodePath, next);
    renameSync(next, link);
  } catch {
    // A plugin can still find a Node that is already on PATH.
  }
}
