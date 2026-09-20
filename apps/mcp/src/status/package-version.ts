import { readFileSync } from "node:fs";

/**
 * The version this package states for itself, read from its own manifest,
 * so the MCP server identity and the npm version cannot drift apart the
 * way a number typed into a file did.
 */
export function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
