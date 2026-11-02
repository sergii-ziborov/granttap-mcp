import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdvertisedModel } from "../../../../packages/protocol/schema";
import { executableOnPath } from "../providers/claude-bin";

/**
 * Claude Code has no listing command, so an installed Claude Code advertises
 * the aliases its `--model` documents. The installed CLI resolves each alias to
 * a concrete version; no version number is invented here. The descriptions are
 * the phone's own localization keys.
 */
const ALIASES: ReadonlyArray<{ modelId: string; label: string; description: string }> = [
  { modelId: "opus", label: "Opus", description: "Latest Opus alias · complex reasoning tasks." },
  { modelId: "sonnet", label: "Sonnet", description: "Latest Sonnet alias · everyday coding tasks." },
  { modelId: "haiku", label: "Haiku", description: "Latest Haiku alias · fast, efficient simple tasks." },
  { modelId: "fable", label: "Fable",
    description: "Fable alias · hardest and longest-running tasks. May require usage credits." },
];

export function claudeAliasRows(endpointId: string, now: number): AdvertisedModel[] {
  return ALIASES.map((alias, priority) => ({ ...alias, provider: "claude" as const, endpointId,
    observedAt: now, source: "advertised" as const, priority }));
}

function hasEntries(dir: string): boolean {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

/** Looked up on disk only: asking `claude --version` would block the catalog cycle. */
function claudeInstalled(home: string, env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.GRANTTAP_CLAUDE_BIN ?? env.NODVOX_CLAUDE_BIN) || executableOnPath("claude", env) !== undefined
    || hasEntries(join(home, ".local", "share", "claude", "versions"))
    || hasEntries(join(home, "Library", "Application Support", "Claude", "claude-code"));
}

let installed = false;
let checkedAt = 0;

/** Rechecked every two minutes, like the other listings; a missing Claude Code advertises nothing. */
export function cachedClaudeModels(endpointId: string, env = process.env, now = Date.now(),
  home = homedir()): AdvertisedModel[] {
  if (now - checkedAt > 120_000) {
    checkedAt = now;
    installed = claudeInstalled(home, env);
  }
  return installed ? claudeAliasRows(endpointId, now) : [];
}
