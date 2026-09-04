/**
 * What version a command-line tool is, without asking it twice.
 *
 * Two installers write the version into the path itself and are trusted as
 * such; anything else is asked `--version` once, and asked again only when
 * the binary on disk changes. A path that merely contains something
 * version-shaped — every nvm install lives under `node/v22.13.1/` — is never
 * read as the tool's own version.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export const SEMVER = /(\d+)\.(\d+)\.(\d+)/;
const ASK_TIMEOUT_MS = 8_000;
const cache = new Map<string, { key: string; version?: string }>();

/**
 * A version the install layout states: the native Claude installer, the Claude
 * app's copies, Cursor's installer, or a Homebrew keg or cask.
 */
export function versionFromLayout(resolvedPath: string): string | undefined {
  const claude = /\/\.local\/share\/claude\/versions\/(\d+\.\d+\.\d+)(?:\/|$)|\/claude-code\/(\d+\.\d+\.\d+)\/claude\.app\//
    .exec(resolvedPath);
  if (claude) return claude[1] ?? claude[2];
  const cursor = /\/cursor-agent\/versions\/([^/]+)\//.exec(resolvedPath);
  if (cursor) return cursor[1];
  const brew = /\/(?:Cellar|Caskroom)\/[^/]+\/([^/]+)\//.exec(resolvedPath);
  return brew?.[1];
}

/** The version an npm install's own manifest states, read without running anything. */
export function versionFromPackage(resolvedPath: string): string | undefined {
  const marker = "/node_modules/";
  const at = resolvedPath.indexOf(marker);
  if (at < 0) return undefined;
  const rest = resolvedPath.slice(at + marker.length).split("/");
  const packageDir = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  try {
    const manifest = JSON.parse(
      readFileSync(join(resolvedPath.slice(0, at + marker.length), ...packageDir, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" && SEMVER.test(manifest.version) ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** Everything a version can be read from without running the tool. */
export function passiveVersion(resolvedPath: string): string | undefined {
  return versionFromLayout(resolvedPath) ?? versionFromPackage(resolvedPath);
}

export function parseVersionOutput(output: string): string | undefined {
  return SEMVER.exec(output)?.[0];
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export type VersionProbe = (path: string) => string | undefined;

/**
 * Ask the tool itself. Only on request — a first run can have side effects (a
 * fresh Grok bootstraps itself into `~/.grok`), so passive status never asks.
 */
export function askVersion(path: string): string | undefined {
  try {
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8", timeout: ASK_TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1" },
    });
    return parseVersionOutput(stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`));
  } catch {
    return undefined;
  }
}

/**
 * The tool's version: what its install states, else what the probe answers,
 * remembered until the binary changes. Without a probe, nothing is run.
 */
export function binaryVersion(path: string, probe?: VersionProbe): string | undefined {
  let resolved: string;
  let key: string;
  try {
    resolved = realpathSync(path);
    const stat = statSync(resolved);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
  const stated = passiveVersion(resolved);
  if (stated || !probe) return stated;
  const hit = cache.get(resolved);
  if (hit && hit.key === key) return hit.version;
  const version = probe(resolved);
  cache.set(resolved, { key, version });
  return version;
}

/** Forget what a path answered: the tool was just replaced. */
export function forgetVersion(path?: string): void {
  if (!path) {
    cache.clear();
    return;
  }
  try {
    cache.delete(realpathSync(path));
  } catch {
    // Nothing remembered for a path that no longer resolves.
  }
}
