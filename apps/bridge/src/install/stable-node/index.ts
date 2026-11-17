import { accessSync, constants, mkdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, join, resolve, win32 } from "node:path";
import { configDir } from "../../config";
import { cachedHookLauncher, hookLauncherParts } from "../../runtime-updates/selection.mjs";

/** User Codex hooks run outside the plugin PATH, including apps started from the Dock. */
export function hookNodeCommand(route: string, nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform): string {
  if (route !== "codex" && route !== "codex-policy") return "node";
  const escaped = platform === "win32" ? nodePath.replaceAll('"', '""')
    : nodePath.replace(/["\\$`]/g, "\\$&");
  return `"${escaped}"`;
}

/** The path a quoted Node token names, undone the way `hookNodeCommand` escaped it. */
function quotedPath(token: string, platform: NodeJS.Platform): string | undefined {
  if (token.length < 3 || !token.startsWith('"') || !token.endsWith('"')) return undefined;
  const inner = token.slice(1, -1);
  return platform === "win32" ? inner.replaceAll('""', '"') : inner.replace(/\\(["\\$`])/g, "$1");
}

/**
 * Whether a hook's Node token is one its route may run with. Other providers keep plain `node`. A
 * Codex hook names a Node by absolute path, and which one was the setup's: the monitor and the MCP
 * server a chat starts can run on different Node versions, and one of them reading the hook must
 * not call the other's hook missing. Any existing executable named `node` by an absolute, quoted
 * path qualifies, the stable link in the configuration folder included; a path that is gone does not.
 */
export function hookNodeAccepted(route: string, token: string, nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform): boolean {
  if (route !== "codex" && route !== "codex-policy") return token === "node";
  if (token === hookNodeCommand(route, nodePath, platform)) return true;
  const path = quotedPath(token, platform);
  if (!path) return false;
  const windows = platform === "win32";
  const absolute = windows ? win32.isAbsolute(path) && /^[A-Za-z]:[\\/]/.test(path) : path.startsWith("/");
  const name = windows ? win32.basename(path).toLowerCase() : basename(path);
  if (!absolute || name !== (windows ? "node.exe" : "node")) return false;
  try {
    if (!statSync(path).isFile()) return false;
    if (!windows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A hook command for `route` that launches the runtime in `root`, or an earlier cached launcher that
 * hands off to it (`current` is that runtime's version), with a Node the route accepts.
 */
export function hookLaunchesRuntime(command: unknown, route: string, root: string, current: string,
  cache = join(configDir(), "runtime-updates")): boolean {
  const node = (token: string) => hookNodeAccepted(route, token);
  const parts = hookLauncherParts(command);
  if (parts && parts.route === route && node(parts.node) && resolve(parts.root) === resolve(root)) return true;
  return cachedHookLauncher(command, route, cache, current, node);
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
