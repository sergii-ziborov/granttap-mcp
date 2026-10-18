import { isAbsolute, join, relative, sep } from "node:path";
import { configDir, loadRuntimeConfig, saveRuntimeConfig, verifiableEngine } from "../../../config";
import { activateConfiguredEngine } from "../../startup";
import { selectEngineArtifact, type EngineArtifact } from "../artifacts";
import { installEngineArtifact } from "../installation";

type MonitorPreparation = { env?: NodeJS.ProcessEnv; artifact?: EngineArtifact; fetcher?: typeof fetch };

/** Monitor only: repair the managed installation without touching custom declarations or policy. */
export async function prepareMonitorEngine(options: MonitorPreparation = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (disabledOrPartial(env)) return false;
  const before = loadRuntimeConfig();
  const configured = env.GRANTTAP_ENGINE_BINARY && env.GRANTTAP_ENGINE_SHA256
    ? { path: env.GRANTTAP_ENGINE_BINARY, sha256: env.GRANTTAP_ENGINE_SHA256 }
    : verifiableEngine(before);
  if (configured && !managedPath(configured.path)) {
    activateConfiguredEngine(env);
    return true;
  }
  const artifact = options.artifact ?? selectEngineArtifact();
  if (!artifact) throw new Error("No verified Engine release is available for this computer yet");
  const declaration = await installEngineArtifact(artifact, { fetcher: options.fetcher });
  const current = loadRuntimeConfig();
  // A settings change made during an offline or slow download wins over this preparation.
  if (disabledOrPartial(env)) return false;
  if (current.enginePath !== before.enginePath || current.engineSha256 !== before.engineSha256) {
    throw new Error("Engine declaration changed during preparation");
  }
  saveRuntimeConfig({ enginePath: declaration.path, engineSha256: declaration.sha256 });
  env.GRANTTAP_ENGINE_BINARY = declaration.path;
  env.GRANTTAP_ENGINE_SHA256 = declaration.sha256;
  activateConfiguredEngine(env);
  return true;
}

function disabledOrPartial(env: NodeJS.ProcessEnv): boolean {
  const flag = env.GRANTTAP_ENGINE_ENABLED?.trim().toLowerCase();
  if (flag !== undefined && flag !== "1" && flag !== "true") return true;
  const path = env.GRANTTAP_ENGINE_BINARY, hash = env.GRANTTAP_ENGINE_SHA256;
  return (path !== undefined || hash !== undefined) && (!path || !hash);
}

function managedPath(path: string): boolean {
  const child = relative(join(configDir(), "engine"), path);
  return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}
