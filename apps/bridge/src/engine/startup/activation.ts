import { loadRuntimeConfig, verifiableEngine } from "../../config";

/** Read the same persisted declaration for hooks, the MCP service and the monitor. */
export function activateConfiguredEngine(env: NodeJS.ProcessEnv = process.env): void {
  const enabled = env.GRANTTAP_ENGINE_ENABLED?.trim().toLowerCase();
  if (enabled !== undefined && enabled !== "1" && enabled !== "true") return;
  const explicitPath = env.GRANTTAP_ENGINE_BINARY, explicitHash = env.GRANTTAP_ENGINE_SHA256;
  // Never pair an explicit executable with a checksum belonging to another file.
  if ((explicitPath !== undefined || explicitHash !== undefined) && (!explicitPath || !explicitHash)) return;
  const declaration = explicitPath && explicitHash
    ? verifiableEngine({ enginePath: explicitPath, engineSha256: explicitHash })
    : verifiableEngine(loadRuntimeConfig());
  if (!declaration) return;
  env.GRANTTAP_ENGINE_BINARY ??= declaration.path;
  env.GRANTTAP_ENGINE_SHA256 ??= declaration.sha256;
  env.GRANTTAP_ENGINE_ENABLED ??= "1";
  env.GRANTTAP_PROJECT_POLICY_ENABLED ??= "1";
}
