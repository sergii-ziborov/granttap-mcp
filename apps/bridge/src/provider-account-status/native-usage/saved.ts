import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ProviderAccountUsage } from "../../../../../packages/protocol/schema";
import { configDir, writePrivateFile } from "../../config";

const Saved = z.array(ProviderAccountUsage).max(8);
const Pauses = z.record(z.string().max(40), z.number().finite());

/**
 * The last good account readings, shared by every GrantTap process on this computer and kept across
 * restarts. A monitor that has just started, or whose next read fails, still knows what was read last.
 * The file holds percentages and reset times only.
 */
export function savedNativeUsage(path = () => join(configDir(), "native-usage.json")) {
  // Beside the readings: the time before which no process here may ask a provider again.
  const schedule = () => path().replace(/\.json$/, "") + "-schedule.json";
  const pauses = (): Record<string, number> => {
    try { return Pauses.parse(JSON.parse(readFileSync(schedule(), "utf8"))); } catch { return {}; }
  };
  return {
    notBefore: pauses,
    defer(provider: string, until: number): void {
      try { writePrivateFile(schedule(), JSON.stringify(Pauses.parse({ ...pauses(), [provider]: until }))); } catch { /* Best effort. */ }
    },
    read(): ProviderAccountUsage[] {
      try { return Saved.parse(JSON.parse(readFileSync(path(), "utf8"))); } catch { return []; }
    },
    write(reports: ProviderAccountUsage[]): void {
      try { writePrivateFile(path(), JSON.stringify(Saved.parse(reports))); } catch { /* Best effort. */ }
    },
  };
}
