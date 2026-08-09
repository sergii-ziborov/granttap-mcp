/**
 * Desktop paste-URI helper — agents can open GrantTap-pair-uri.txt when chat UI
 * hides the connect text block.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PAIRING_CODE_TTL_MINUTES } from "./pairing";

export function pairUriDesktopDir(): string {
  return process.env.GRANTTAP_DESKTOP_DIR?.trim() || join(homedir(), "Desktop");
}

export function pairUriDesktopPath(): string {
  return join(pairUriDesktopDir(), "GrantTap-pair-uri.txt");
}

/** Write the full granttap://pair-v2 URI for phone paste / Desktop open. */
export function writePairUriDesktopFile(uri: string): string {
  const dir = pairUriDesktopDir();
  mkdirSync(dir, { recursive: true });
  const path = pairUriDesktopPath();
  writeFileSync(path, `${uri.trim()}\n`, { encoding: "utf8", mode: 0o644 });
  return path;
}

/** Connect-tool / CLI text that always embeds the full paste URI. */
export function formatConnectPasteText(options: {
  uri: string;
  httpBase: string;
  desktopPath?: string | null;
}): string {
  const lines = [
    "Pair this Mac with GrantTap (QR optional — paste is enough):",
    "",
    "PASTE THIS in GrantTap → Settings → Connections → Paste / Add computer:",
    options.uri,
    "",
    `Relay: ${options.httpBase}`,
    `One-time link — expires in ${PAIRING_CODE_TTL_MINUTES} minutes.`,
  ];
  if (options.desktopPath) {
    lines.push(`Also on Desktop: ${options.desktopPath}`);
  }
  return lines.join("\n");
}
