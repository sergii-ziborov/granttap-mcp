import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { configDir } from "../config/paths";
import { loadRuntimeConfig, saveRuntimeConfig } from "../config";

/**
 * Where a separately distributed engine is expected to sit.
 *
 * Governance is configured from the phone, so declaring the engine cannot be a
 * step that exists only in a text editor. `setup` finds the binary, checksums
 * it, and writes the declaration the publishing LaunchAgent reads.
 */
export function defaultEngineLocations(home: string = homedir()): string[] {
  return [
    join(configDir(), "engine", "granttap-engine"),
    join(home, ".local", "bin", "granttap-engine"),
    "/usr/local/bin/granttap-engine",
    "/opt/homebrew/bin/granttap-engine",
  ];
}

export type EngineDeclaration = { path: string; sha256: string };

/** Usable only as an absolute, executable regular file — never a symlink. */
export function usableEngineBinary(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function declarationFor(path: string): EngineDeclaration | null {
  if (!usableEngineBinary(path)) return null;
  try {
    return {
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  } catch {
    return null;
  }
}

/**
 * Declare an engine so the publishing LaunchAgent can enable Governance.
 *
 * An explicit path wins; otherwise the standard locations are searched. The
 * checksum is taken here rather than trusted from elsewhere, because it is the
 * only thing the supervisor verifies the binary against before launching it.
 */
export function declareEngine(explicitPath?: string): EngineDeclaration | null {
  const candidates = explicitPath ? [explicitPath] : defaultEngineLocations();
  for (const candidate of candidates) {
    const declaration = declarationFor(candidate);
    if (!declaration) continue;
    const current = loadRuntimeConfig();
    if (current.enginePath !== declaration.path
      || current.engineSha256 !== declaration.sha256) {
      saveRuntimeConfig({
        enginePath: declaration.path,
        engineSha256: declaration.sha256,
      });
    }
    return declaration;
  }
  return null;
}
