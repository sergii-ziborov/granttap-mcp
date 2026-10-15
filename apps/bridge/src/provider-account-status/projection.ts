import type { AdvertisedModel, ProviderAccountUsage } from "../../../../packages/protocol/schema";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const text = (value: unknown) => typeof value === "string"
  ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined : undefined;

/** The account API's allowlist, never its identity, instructions or credits. */
export function projectAccountModels(value: any, endpointId: string, now: number): AdvertisedModel[] {
  if (!Array.isArray(value?.data)) return [];
  const rows = new Map<string, AdvertisedModel>();
  for (const item of value.data) {
    if (item?.hidden === true || typeof item?.model !== "string" || !ID.test(item.model)) continue;
    rows.set(item.model, { modelId: item.model, endpointId, provider: "codex", source: "advertised",
      label: text(item.displayName), description: text(item.description), priority: rows.size, observedAt: now });
    if (rows.size === 64) break;
  }
  return [...rows.values()];
}

export function projectAccountUsage(value: any, now: number): ProviderAccountUsage[] {
  const limits = value?.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === "object"
    ? Object.values(value.rateLimitsByLimitId) : value?.rateLimits ? [value.rateLimits] : [];
  return limits.slice(0, 16).flatMap((item: any) => {
    const limitId = text(item?.limitId) ?? "codex";
    if (!ID.test(limitId)) return [];
    const windows = (["primary", "secondary"] as const).flatMap(id => {
      const row = item?.[id];
      if (!Number.isFinite(row?.usedPercent) || row.usedPercent < 0 || row.usedPercent > 100
        || !Number.isInteger(row?.windowDurationMins) || row.windowDurationMins <= 0
        || !Number.isFinite(row?.resetsAt) || row.resetsAt <= 0) return [];
      return [{ id, usedPercent: row.usedPercent, windowMinutes: row.windowDurationMins,
        resetsAt: row.resetsAt * 1_000 }];
    });
    return windows.length ? [{ provider: "codex" as const, limitId, observedAt: now, windows }] : [];
  });
}
