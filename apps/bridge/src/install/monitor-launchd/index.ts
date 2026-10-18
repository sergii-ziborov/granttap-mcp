import { loadRuntimeConfig, verifiableEngine } from "../../config";

/** LaunchAgent compatibility for older launchers; current launchers also read the saved declaration. */
export function monitorEngineEnvironment(): string[] {
  const engine = verifiableEngine(loadRuntimeConfig());
  if (!engine) return [];
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  return [
    "    <key>GRANTTAP_ENGINE_BINARY</key>", `    <string>${xml(engine.path)}</string>`,
    "    <key>GRANTTAP_ENGINE_SHA256</key>", `    <string>${xml(engine.sha256)}</string>`,
    "    <key>GRANTTAP_ENGINE_ENABLED</key>", "    <string>1</string>",
    "    <key>GRANTTAP_PROJECT_POLICY_ENABLED</key>", "    <string>1</string>",
  ];
}

/** Older generated helpers encoded "not installed yet" as two permanent disable flags. */
export function legacyUnconfiguredEngine(contents: string): boolean {
  return contents.includes("<string>com.granttap.monitor</string>")
    && /granttap-mcp\.mjs<\/string>/.test(contents)
    && /<string>internal<\/string>\s*<string>monitor<\/string>/.test(contents)
    && !/GRANTTAP_ENGINE_(BINARY|SHA256)/.test(contents)
    && /<key>GRANTTAP_ENGINE_ENABLED<\/key>\s*<string>0<\/string>/.test(contents)
    && /<key>GRANTTAP_PROJECT_POLICY_ENABLED<\/key>\s*<string>0<\/string>/.test(contents);
}
