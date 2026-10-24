import { homedir } from "node:os";
import type { ProviderAccountUsage } from "../../../../../packages/protocol/schema";
import { readClaudeUsage } from "../claude-statusline";
import { readNativeCredential } from "./credentials";
import { createNativeAccountUsageReader } from "./reader";

let scope = "";
let reader = createNativeAccountUsageReader({ credential: readNativeCredential });

export function mergeNativeUsage(direct: ProviderAccountUsage[], statusLine: ProviderAccountUsage[],
  now = Date.now()): ProviderAccountUsage[] {
  const newest = new Map<string, ProviderAccountUsage>();
  for (const report of [...direct, ...statusLine]) {
    const key = `${report.provider}\u001f${report.limitId}`;
    const windows = report.windows.filter(window => window.resetsAt > now);
    if (!windows.length || now - report.observedAt > 300_000 || report.observedAt > now + 60_000) continue;
    if ((newest.get(key)?.observedAt ?? -Infinity) <= report.observedAt) newest.set(key, { ...report, windows });
  }
  return [...newest.values()];
}

/** Account reads are scheduled beside the catalog; provider credentials never enter its result. */
export function cachedNativeAccountUsage(): ProviderAccountUsage[] {
  const env = process.env;
  const current = [homedir(), env.GRANTTAP_CLAUDE_DIR, env.NODVOX_CLAUDE_DIR, env.CLAUDE_CONFIG_DIR,
    env.GRANTTAP_GROK_DIR, env.XDG_CONFIG_HOME, env.APPDATA].join("\u001f");
  if (scope !== current) { scope = current; reader = createNativeAccountUsageReader({ credential: readNativeCredential }); }
  void reader.refresh();
  return mergeNativeUsage(reader.current(), readClaudeUsage());
}
