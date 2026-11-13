import { homedir } from "node:os";
import type { ProviderAccountUsage } from "../../../../../packages/protocol/schema";
import { readClaudeUsage } from "../claude-statusline";
import { claudeAccessRenewable, claudeCredentialState, readNativeCredential } from "./credentials";
import { createNativeAccountUsageReader, HELD_USAGE_MS, isSignedOutUsage } from "./reader";
import { savedNativeUsage } from "./saved";
import { providerAuthentication } from "../../device-management/provider-command";

/**
 * Claude Code's own CLI decides whether its login lapsed, whether or not the desktop app runs. A saved
 * record alone said "expired" while phone messages kept running through the CLI.
 */
export async function claudeLoginLapsed(read = () => claudeCredentialState(),
  cli = () => providerAuthentication("claude")): Promise<boolean> {
  return await read() === "expired" && await cli() === "signed-out";
}

let scope = "";
const create = () => createNativeAccountUsageReader({ credential: readNativeCredential,
  expired: async provider => provider === "claude" && await claudeLoginLapsed(),
  renewable: async provider => provider === "claude" && await claudeAccessRenewable(),
  saved: savedNativeUsage(),
  report: (provider, reason) => process.stderr.write(reason
    ? `[granttap-mcp] ${provider} account limits unavailable: ${reason}\n`
    : `[granttap-mcp] ${provider} account limits readable again\n`) });
let reader = create();

export function mergeNativeUsage(direct: ProviderAccountUsage[], statusLine: ProviderAccountUsage[],
  now = Date.now()): ProviderAccountUsage[] {
  const newest = new Map<string, ProviderAccountUsage>();
  for (const report of [...direct, ...statusLine]) {
    const key = `${report.provider}\u001f${report.limitId}`;
    const windows = report.windows.filter(window => window.resetsAt > now);
    const held = isSignedOutUsage(report) ? 300_000 : HELD_USAGE_MS;
    if ((!windows.length && !isSignedOutUsage(report)) || now - report.observedAt > held
      || report.observedAt > now + 60_000) continue;
    if ((newest.get(key)?.observedAt ?? -Infinity) <= report.observedAt) newest.set(key, { ...report, windows });
  }
  return [...newest.values()];
}

/** Account reads are scheduled beside the catalog; provider credentials never enter its result. */
export function cachedNativeAccountUsage(): ProviderAccountUsage[] {
  const env = process.env;
  const current = [homedir(), env.GRANTTAP_CLAUDE_DIR, env.NODVOX_CLAUDE_DIR, env.CLAUDE_CONFIG_DIR,
    env.GRANTTAP_GROK_DIR, env.XDG_CONFIG_HOME, env.APPDATA].join("\u001f");
  if (scope !== current) { scope = current; reader = create(); }
  void reader.refresh();
  return mergeNativeUsage(reader.current(), readClaudeUsage());
}
