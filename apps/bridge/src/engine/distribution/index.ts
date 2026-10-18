import { join } from "node:path";
import { configDir, loadRuntimeConfig, saveRuntimeConfig } from "../../config";
import { declarationFor, type EngineDeclaration } from "../protocol/engine-declaration";
import { verifyEngineBinary } from "../runtime/engine-supervisor";
import { activateConfiguredEngine } from "../startup";
import { selectEngineArtifact, validateEngineArtifact, type EngineArtifact } from "./artifacts";
import { downloadEngine } from "./download";
import { privateEngineDirectory, writeEngineExecutable } from "./storage";

export { selectEngineArtifact, type EngineArtifact } from "./artifacts";

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
export async function prepareEngine(explicitPath?: string): Promise<EngineDeclaration> {
  const configured = loadRuntimeConfig();
  const managedRoot = join(configDir(), "engine");
  const customPath = explicitPath ?? (configured.enginePath && !configured.enginePath.startsWith(managedRoot + "/")
    && !configured.enginePath.startsWith(managedRoot + "\\") ? configured.enginePath : undefined);
  const declaration = customPath ? declarationFor(customPath)
    : await installEngineArtifact(selectEngineArtifact() ?? missingArtifact());
  if (!declaration) throw new Error("The selected Engine must be an executable regular file");
  saveRuntimeConfig({ enginePath: declaration.path, engineSha256: declaration.sha256 });
  // Setup's preload may still contain the previous managed declaration.
  process.env.GRANTTAP_ENGINE_BINARY = declaration.path;
  process.env.GRANTTAP_ENGINE_SHA256 = declaration.sha256;
  activateConfiguredEngine();
  return declaration;
}

function missingArtifact(): never { throw new Error("No verified Engine release is available for this computer yet"); }
