import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { AdvertisedModel } from "../../../../packages/protocol/schema";

const MAX_BYTES = 2_000_000;
const MAX_AGE = 24 * 60 * 60_000;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = typeof EFFORTS[number];

export type GrokModelDetail = Pick<AdvertisedModel, "label" | "description" | "supportedEfforts">;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) || undefined;
}

function readBounded(path: string): unknown {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(size);
    return JSON.parse(bytes.subarray(0, readSync(fd, bytes, 0, size, 0)).toString("utf8"));
  } finally { closeSync(fd); }
}

function efforts(info: Record<string, unknown>): Effort[] | undefined {
  if (info.supports_reasoning_effort !== true || !Array.isArray(info.reasoning_efforts)) return undefined;
  const values = info.reasoning_efforts.map((row) => (row as { value?: unknown } | null)?.value);
  const known = EFFORTS.filter((effort) => values.includes(effort));
  return known.length ? known : undefined;
}

/**
 * Picker metadata from the catalog Grok Build itself fetched for this account:
 * display names, descriptions and the reasoning levels each model accepts.
 * Identity, endpoints, keys and headers never leave the file.
 */
export function readGrokModelDetails(
  root: string, now = Date.now(),
): { fetchedAt: number; models: Map<string, GrokModelDetail> } | undefined {
  try {
    const cache = readBounded(join(root, "models_cache.json")) as Record<string, unknown> | undefined;
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) return undefined;
    const fetchedAt = typeof cache.fetched_at === "string" ? Date.parse(cache.fetched_at) : NaN;
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > MAX_AGE || fetchedAt - now > 5 * 60_000) return undefined;
    if (!cache.models || typeof cache.models !== "object" || Array.isArray(cache.models)) return undefined;
    const models = new Map<string, GrokModelDetail>();
    for (const [key, value] of Object.entries(cache.models as Record<string, unknown>).slice(0, 64)) {
      const info = (value as { info?: unknown } | null)?.info as Record<string, unknown> | undefined;
      if (!info || typeof info !== "object" || info.hidden === true || !MODEL_ID.test(key)) continue;
      const supportedEfforts = efforts(info);
      models.set(key, { label: text(info.name, 160), description: text(info.description, 240),
        ...(supportedEfforts ? { supportedEfforts } : {}) });
    }
    return { fetchedAt, models };
  } catch { return undefined; }
}

/** The CLI list stays authoritative; the cache only names and describes its rows. */
export function enrichGrokModels(rows: AdvertisedModel[], root: string, now = Date.now()): AdvertisedModel[] {
  const details = readGrokModelDetails(root, now);
  return rows.map((row, priority) => {
    const detail = details?.models.get(row.modelId);
    return { ...row, priority, ...(detail?.label ? { label: detail.label } : {}),
      ...(detail?.description ? { description: detail.description } : {}),
      ...(detail?.supportedEfforts ? { supportedEfforts: detail.supportedEfforts } : {}) };
  });
}
