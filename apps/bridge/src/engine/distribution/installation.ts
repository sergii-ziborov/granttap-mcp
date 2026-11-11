import { join } from "node:path";
import { configDir, loadRuntimeConfig, saveRuntimeConfig, verifiableEngine } from "../../config";
import { declarationFor, declareEngine, defaultEngineLocations, type EngineDeclaration } from "../protocol/engine-declaration";
import { verifyEngineBinary } from "../runtime/engine-supervisor";
import { activateConfiguredEngine } from "../startup";
import { selectEngineArtifact, validateEngineArtifact, type EngineArtifact } from "./artifacts";
import { downloadEngine } from "./download";
import { privateEngineDirectory, writeEngineExecutable } from "./storage";

export { selectEngineArtifact, type EngineArtifact } from "./artifacts";

/** Host selection and network are injectable so tests never depend on this computer's release. */
export type EnginePreparationOptions = { platform?: string; arch?: string; fetcher?: typeof fetch };

/** Setup's outcome: the declared Engine, if any, and why the pinned release could not be prepared. */
export type SetupEngine = { declaration: EngineDeclaration | null; reason?: string };

export async function installEngineArtifact(artifact: EngineArtifact, options: {
  directory?: string; fetcher?: typeof fetch;
} = {}): Promise<EngineDeclaration> {
  validateEngineArtifact(artifact);
  const directory = options.directory ?? join(configDir(), "engine");
  await privateEngineDirectory(directory);
  const version = join(directory, `${artifact.version}-${artifact.sha256.slice(0, 16)}`);
  await privateEngineDirectory(version);
  const path = join(version, artifact.platform === "win32" ? "granttap-engine.exe" : "granttap-engine");
  try { return await verifyEngineBinary(path, artifact.sha256); } catch { /* Repair only this pinned version's cache. */ }
  const bytes = await downloadEngine(artifact, options.fetcher ?? fetch);
  await writeEngineExecutable(path, bytes);
  return verifyEngineBinary(path, artifact.sha256);
}

/** Setup only: downloads never run in a provider hook or delay the first catalog. */
export async function prepareEngine(explicitPath?: string, options: EnginePreparationOptions = {}): Promise<EngineDeclaration> {
  const configured = loadRuntimeConfig();
  const managedRoot = join(configDir(), "engine");
  const customPath = explicitPath ?? (configured.enginePath && !configured.enginePath.startsWith(managedRoot + "/")
    && !configured.enginePath.startsWith(managedRoot + "\\") ? configured.enginePath : undefined);
  const declaration = customPath ? declarationFor(customPath)
    : await installEngineArtifact(selectEngineArtifact(options.platform, options.arch) ?? missingArtifact(),
      { fetcher: options.fetcher });
  if (!declaration) {
    throw new Error(explicitPath ? "The selected Engine must be an executable regular file"
      : "The configured Engine is no longer an executable regular file");
  }
  saveRuntimeConfig({ enginePath: declaration.path, engineSha256: declaration.sha256 });
  activate(declaration);
  return declaration;
}

/**
 * Setup never aborts for a missing Engine. When the pinned release cannot be
 * prepared, a verified Engine already declared here is kept; otherwise the
 * standard locations are searched. With neither, Graph stays unavailable.
 * An explicitly selected executable is never replaced by another one.
 */
export async function prepareSetupEngine(explicitPath?: string, options: EnginePreparationOptions & {
  locations?: string[];
} = {}): Promise<SetupEngine> {
  try {
    return { declaration: await prepareEngine(explicitPath, options) };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");
    const kept = explicitPath ? null
      : await installedEngine(options.locations ?? defaultEngineLocations()).catch(() => null);
    if (kept) activate(kept);
    return { declaration: kept, reason };
  }
}

async function installedEngine(locations: string[]): Promise<EngineDeclaration | null> {
  const previous = verifiableEngine(loadRuntimeConfig());
  // The saved checksum is the trust anchor for the previous Engine; it is never re-derived from changed bytes.
  if (previous) {
    try { return await verifyEngineBinary(previous.path, previous.sha256); } catch { /* Search the standard locations. */ }
  }
  for (const location of locations) {
    const declaration = declareEngine(location);
    if (declaration) return declaration;
  }
  return null;
}

function activate(declaration: EngineDeclaration): void {
  // Setup's preload may still contain the previous managed declaration.
  process.env.GRANTTAP_ENGINE_BINARY = declaration.path;
  process.env.GRANTTAP_ENGINE_SHA256 = declaration.sha256;
  activateConfiguredEngine();
}

function missingArtifact(): never { throw new Error("No verified Engine release is available for this computer yet"); }
