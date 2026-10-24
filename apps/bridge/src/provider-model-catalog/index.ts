import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdvertisedModel, EndpointModelCatalog } from "../../../../packages/protocol/schema";

import { cachedCLIModels } from "./cli-models";
import { cachedNativeAccountUsage, cachedProviderAccount } from "../provider-account-status";

const MAX_BYTES = 2_000_000;
const MAX_AGE = 24 * 60 * 60_000;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;

function shortText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined;
}

function row(value: unknown, endpointId: string, observedAt: number): AdvertisedModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const native = value as Record<string, unknown>;
  if (native.visibility !== "list" || typeof native.slug !== "string" || !MODEL_ID.test(native.slug)) return undefined;
  return {
    modelId: native.slug, provider: "codex", endpointId, source: "advertised", observedAt,
    label: shortText(native.display_name), description: shortText(native.description),
    ...(Number.isInteger(native.priority) && Number(native.priority) >= 0 && Number(native.priority) <= 10_000
      ? { priority: Number(native.priority) } : {}),
  };
}

function readCache(path: string): Record<string, unknown> {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_BYTES) throw new Error("Native model catalog exceeds its bound.");
    const bytes = Buffer.alloc(size);
    const count = readSync(fd, bytes, 0, size, 0);
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally { closeSync(fd); }
}

/** Project only picker metadata from Codex's account-scoped cache, never prompts or identity. */
function readCachedCodexModels(
  endpointId: string, options: { path?: string; now?: number; env?: NodeJS.ProcessEnv } = {},
): EndpointModelCatalog {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const root = env.GRANTTAP_CODEX_DIR ?? env.NODVOX_CODEX_DIR ?? env.CODEX_HOME ?? join(homedir(), ".codex");
  const missing: EndpointModelCatalog = { endpointId, observedAt: now, stale: true, models: [], reason: "not_reported" };
  try {
    const cache = readCache(options.path ?? join(root, "models_cache.json"));
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) return missing;
    const fetchedAt = typeof cache.fetched_at === "string" ? Date.parse(cache.fetched_at) : NaN;
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > MAX_AGE || fetchedAt - now > 5 * 60_000) {
      return { ...missing, reason: "provider_catalog_expired" };
    }
    if (!Array.isArray(cache.models)) return missing;
    const models = new Map<string, AdvertisedModel>();
    for (const value of cache.models) {
      const item = row(value, endpointId, fetchedAt);
      if (item) models.set(item.modelId, item);
    }
    return { endpointId, observedAt: fetchedAt, stale: false,
      models: [...models.values()].sort((a, b) => (a.priority ?? 10_000) - (b.priority ?? 10_000)).slice(0, 64),
    };
  } catch { return missing; }
}

/** Fresh native account metadata takes precedence over an expired on-disk cache. */
export function readCodexModelCatalog(
  endpointId: string, options: Parameters<typeof readCachedCodexModels>[1] = {},
): EndpointModelCatalog {
  const cached = readCachedCodexModels(endpointId, options);
  if (options.path) return cached;
  const live = cachedProviderAccount(endpointId, options.env);
  if (!live) return cached;
  return live.models.length ? live : { ...cached, accountUsage: live.accountUsage };
}

/** A shared endpoint catalog for all four existing coding providers. */
export function readProviderModelCatalog(endpointId: string): EndpointModelCatalog {
  const codex = readCodexModelCatalog(endpointId);
  const cli = cachedCLIModels(endpointId);
  return { ...codex, observedAt: Math.max(codex.observedAt, ...cli.map(row => row.observedAt)),
    accountUsage: [...(codex.accountUsage ?? []), ...cachedNativeAccountUsage()],
    stale: codex.stale === true && cli.length === 0, models: [...codex.models, ...cli].slice(0, 256) };
}
