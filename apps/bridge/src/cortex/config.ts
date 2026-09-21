export const DEFAULT_CORTEX_MAX_TOKENS = 16_384;

export type CortexProjectConfig = {
  enabled: boolean;
  maxTokens: number;
};

function parseConfig(raw: unknown): CortexProjectConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const maxTokens = Number(value.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 512 || maxTokens > 262_144) {
    return null;
  }
  return {
    enabled: value.enabled === true,
    maxTokens,
  };
}

export function parseCortexByProject(raw: unknown): Record<string, CortexProjectConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const parsed: Record<string, CortexProjectConfig> = {};
  for (const [projectId, value] of Object.entries(raw as Record<string, unknown>).slice(0, 128)) {
    const config = parseConfig(value);
    if (projectId.trim() && projectId.length <= 128 && config) parsed[projectId] = config;
  }
  return parsed;
}

export function defaultCortexConfig(): CortexProjectConfig {
  return {
    enabled: false,
    maxTokens: DEFAULT_CORTEX_MAX_TOKENS,
  };
}
