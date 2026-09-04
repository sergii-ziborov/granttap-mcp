/**
 * Which Claude Code answers the phone.
 *
 * A chat the user opened in the Claude desktop app was written by the Claude
 * Code the app ships, and an older `claude` on PATH cannot resume it: the API
 * refuses with "Claude Code X does not support model version Y". The app keeps
 * its own copies of Claude Code on this Mac, and the native installer keeps
 * every version it ever installed, so the newest one present is the one to
 * use. Nothing is downloaded or updated here — the helper never changes the
 * user's tools — only chosen. An explicit `GRANTTAP_CLAUDE_BIN` still wins.
 */
import { accessSync, constants, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

export type ClaudeBinary = { path: string; version?: string };

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `2.1.260` from a path segment such as `2.1.260` or `claude-2.1.260`. */
export function versionOf(segment: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(segment)?.[0];
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function onPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function versioned(path: string): ClaudeBinary {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // A dangling link is still the user's choice; keep the path as given.
  }
  // The native installer links `claude` to `.../versions/<version>`; the app
  // keeps `.../claude-code/<version>/claude.app/Contents/MacOS/claude`.
  const segments = resolved.split("/").reverse();
  for (const segment of segments) {
    const version = versionOf(segment);
    if (version) return { path, version };
  }
  return { path };
}

function children(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every Claude Code this Mac keeps, newest first; PATH's own `claude` included. */
export function installedClaudeBinaries(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ClaudeBinary[] {
  const found: ClaudeBinary[] = [];
  const fromPath = onPath("claude", env);
  if (fromPath) found.push(versioned(fromPath));
  const installer = join(home, ".local", "share", "claude", "versions");
  for (const name of children(installer)) {
    const path = join(installer, name);
    if (versionOf(name) && executable(path)) found.push({ path, version: versionOf(name) });
  }
  const app = join(home, "Library", "Application Support", "Claude", "claude-code");
  for (const name of children(app)) {
    const path = join(app, name, "claude.app", "Contents", "MacOS", "claude");
    if (versionOf(name) && executable(path)) found.push({ path, version: versionOf(name) });
  }
  return found.sort((left, right) => {
    if (left.version && right.version) return compareVersions(right.version, left.version);
    return left.version ? -1 : right.version ? 1 : 0;
  });
}

/**
 * The Claude Code to run: the explicit override, else the newest installed,
 * else plain `claude` for PATH to resolve.
 */
export function resolveClaudeBinary(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ClaudeBinary {
  const override = env.GRANTTAP_CLAUDE_BIN ?? env.NODVOX_CLAUDE_BIN;
  if (override) return versioned(override);
  return installedClaudeBinaries(home, env)[0] ?? { path: "claude" };
}

/**
 * The failure a too-old Claude Code reports, with the way out attached: the
 * version that answered, and the one command that replaces it.
 */
export function explainClaudeFailure(error: string, binary: ClaudeBinary): string {
  if (!/does not support|not supported|outdated|update claude code|upgrade/i.test(error)) return error;
  const which = binary.version ? `Claude Code ${binary.version}` : "This Claude Code";
  return `${error.trim()} — ${which} at ${binary.path} is older than this chat needs. `
    + "Run `claude update` on this Mac, or open the chat in the Claude app once so its newer Claude Code is present.";
}
