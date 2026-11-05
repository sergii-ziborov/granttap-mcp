import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../config/runtime/paths";
import { writePrivateFile } from "../../config/access/write-private";

const recordPath = () => join(configDir(), "relay-link-restart.json");

/**
 * A fresh process helps when the monitor's own link state wedged, and cannot help when the relay
 * refuses this computer for good. One restart an hour, remembered across restarts, gives the first
 * case its cure without turning the second into a restart loop. A record that cannot be written
 * (a full disk) claims nothing, for the same reason.
 */
export function claimLinkRestart(now = Date.now(), spacingMs = 60 * 60_000): boolean {
  let last = -Infinity;
  try {
    const value = JSON.parse(readFileSync(recordPath(), "utf8")) as { at?: unknown };
    if (typeof value.at === "number" && Number.isFinite(value.at)) last = value.at;
  } catch { /* no restart recorded yet */ }
  if (last <= now && now - last < spacingMs) return false;
  try { writePrivateFile(recordPath(), JSON.stringify({ at: now })); } catch { return false; }
  return true;
}
