import type { AdvertisedModel, EndpointModelCatalog, MeshProvider } from "../../../../../packages/protocol/schema";

const PROVIDERS = new Set(["claude", "codex", "cursor", "grok"]);

function providerOf(value: string): MeshProvider | undefined {
  return PROVIDERS.has(value) ? value as MeshProvider : undefined;
}

/** Observed session models for one endpoint. Cached rows are last seen, not proof. */
export function catalogFromSessions(
  endpointId: string,
  sessions: Array<{ agent: string; computerId?: string; model?: string; lastActivityAt?: number }>,
  now = Date.now(),
): EndpointModelCatalog {
  const models = new Map<string, AdvertisedModel>();
  for (const session of sessions) {
    if (session.computerId && session.computerId !== endpointId) continue;
    const provider = providerOf(session.agent);
    const modelId = session.model?.trim();
    if (!provider || !modelId) continue;
    const key = `${provider}\0${modelId}`;
    models.set(key, {
      modelId,
      provider,
      endpointId,
      source: "observed",
      observedAt: session.lastActivityAt ?? now,
    });
  }
  const list = [...models.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
  return {
    endpointId,
    observedAt: now,
    models: list,
    ...(list.length === 0 ? { reason: "not_reported" } : {}),
  };
}

export function allowedModelIds(
  catalog: EndpointModelCatalog | undefined,
  granted: string[] | undefined,
): string[] {
  const advertised = catalog?.models.map((item) => item.modelId) ?? [];
  if (!granted || granted.length === 0) return advertised;
  const allow = new Set(granted);
  return advertised.filter((item) => allow.has(item));
}
