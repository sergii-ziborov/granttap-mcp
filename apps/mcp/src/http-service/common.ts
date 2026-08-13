import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const HTTP_SERVICE_LABEL = "com.granttap.mcp-http";

export function httpMcpLaunchAgentPath(): string {
  const agentsDir = process.env.GRANTTAP_LAUNCH_AGENTS_DIR
    ?? join(homedir(), "Library", "LaunchAgents");
  return join(agentsDir, `${HTTP_SERVICE_LABEL}.plist`);
}

export function isOwnedHttpService(contents: string): boolean {
  return contents.includes(`<string>${HTTP_SERVICE_LABEL}</string>`)
    && /granttap(?:-mcp)?(?:\.mjs)?<\/string>/.test(contents)
    && /<string>serve<\/string>/.test(contents);
}

export function isConfiguredHttpService(contents: string): boolean {
  const launcher = join(packageRoot, "bin", "granttap-mcp.mjs");
  return contents.includes(`<string>${HTTP_SERVICE_LABEL}</string>`)
    && contents.includes(`<string>${xml(launcher)}</string>`)
    && /<string>serve<\/string>/.test(contents)
    && !contents.includes("Cursor.app")
    && !contents.includes("/helpers/node");
}

export function isHttpMcpServiceLoaded(): boolean {
  if (process.platform !== "darwin" || process.env.GRANTTAP_SKIP_LAUNCHCTL === "1") return false;
  const uid = process.getuid?.();
  if (uid == null) return false;
  return spawnSync(
    "launchctl",
    ["print", `gui/${uid}/${HTTP_SERVICE_LABEL}`],
    { stdio: "ignore" },
  ).status === 0;
}

export function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
