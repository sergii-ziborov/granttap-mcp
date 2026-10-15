/** Provider-native controls, never interpolated into a prompt or shell. */
export function providerEffortArgs(provider: string, effort?: string): string[] {
  if (!effort) return [];
  const supported = provider === "codex" ? ["low", "medium", "high", "xhigh", "max", "ultra"]
    : provider === "claude" ? ["low", "medium", "high", "xhigh", "max"]
    : provider === "grok" ? ["low", "medium", "high"] : [];
  if (!supported.includes(effort)) return [];
  return provider === "codex" ? ["-c", `model_reasoning_effort="${effort}"`]
    : [provider === "grok" ? "--reasoning-effort" : "--effort", effort];
}
