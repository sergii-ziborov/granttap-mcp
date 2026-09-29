import type { AdvertisedModel, EndpointModelCatalog, MeshProvider } from "../../../../../packages/protocol/schema";
import { readCodexModelCatalog } from "../../provider-model-catalog";

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
    if (!provider || !modelId || /^<[^>]+>$/.test(modelId)) continue;
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
  provider?: string,
): string[] {
  const advertised = catalog?.models.filter((item) => provider == null || item.provider === provider)
    .map((item) => item.modelId) ?? [];
  if (granted === undefined) return advertised;
  const allow = new Set(granted);
  return advertised.filter((item) => allow.has(item));
}

/** Native availability replaces old Codex observations; other providers retain their evidence. */
export function catalogFromEndpoint(
  endpointId: string, sessions: Parameters<typeof catalogFromSessions>[1], now = Date.now(),
): EndpointModelCatalog {
  const observed = catalogFromSessions(endpointId, sessions, now);
  const native = readCodexModelCatalog(endpointId, { now });
  const models = [...native.models, ...observed.models.filter(item => native.stale || item.provider !== "codex")];
  return { endpointId, observedAt: now, models: models.slice(0, 64),
    ...(native.stale ? { stale: true, reason: native.reason } : {}),
  };
}
