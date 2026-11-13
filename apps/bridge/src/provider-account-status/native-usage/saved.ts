import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ProviderAccountUsage } from "../../../../../packages/protocol/schema";
import { configDir, writePrivateFile } from "../../config";

const Saved = z.array(ProviderAccountUsage).max(8);

/**
 * The last good account readings, shared by every GrantTap process on this computer and kept across
 * restarts. A monitor that has just started, or whose next read fails, still knows what was read last.
 * The file holds percentages and reset times only.
 */
export function savedNativeUsage(path = () => join(configDir(), "native-usage.json")) {
  return {
    read(): ProviderAccountUsage[] {
      try { return Saved.parse(JSON.parse(readFileSync(path(), "utf8"))); } catch { return []; }
    },
    write(reports: ProviderAccountUsage[]): void {
      try { writePrivateFile(path(), JSON.stringify(Saved.parse(reports))); } catch { /* Best effort. */ }
    },
  };
}
