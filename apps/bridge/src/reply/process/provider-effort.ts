import type { SessionInfo } from "../../../../../packages/protocol/schema";

/** Provider-native controls, never interpolated into a prompt or shell. */
export function providerEffortArgs(provider: string, effort?: string): string[] {
  if (!effort) return [];
  // Grok Build lists low…xhigh per model in its own catalog; it has no max.
  const supported = provider === "codex" ? ["low", "medium", "high", "xhigh", "max", "ultra"]
    : provider === "claude" ? ["low", "medium", "high", "xhigh", "max"]
    : provider === "grok" ? ["low", "medium", "high", "xhigh"] : [];
  if (!supported.includes(effort)) return [];
  return provider === "codex" ? ["-c", `model_reasoning_effort="${effort}"`]
    : [provider === "grok" ? "--reasoning-effort" : "--effort", effort];
}

/**
 * The effort a resumed headless turn runs with. Without the flag the CLI starts at its own default
 * (Claude Code's is medium, Codex's is config.toml's), not at the chat's: a phone follow-up to a
 * chat begun at xhigh ran at medium. A turn that names no effort keeps the one the chat's latest
 * request used, as its catalog row reports it. Codex levels differ by model, so a turn that
 * switches the Codex model keeps nothing; Claude Code retries a level a model refuses without it.
 */
export function resumedEffort(provider: string, session: Pick<SessionInfo, "model" | "effort">,
  turn: { model?: string; effort?: string }): string | undefined {
  if (turn.effort) return turn.effort;
  if (provider === "codex" && turn.model && turn.model !== session.model) return undefined;
  return providerEffortArgs(provider, session.effort).length ? session.effort : undefined;
}
