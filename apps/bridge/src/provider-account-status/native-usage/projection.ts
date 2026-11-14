import type { ProviderAccountUsage } from "../../../../../packages/protocol/schema";

type ProviderUsageWindow = ProviderAccountUsage["windows"][number];

export type NativeUsageProvider = "claude" | "cursor" | "grok";

function percent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

/** Only allowance windows cross the wire; identity, money and top-up settings never do. */
export function projectNativeAccountUsage(provider: NativeUsageProvider, input: any,
  now = Date.now()): ProviderAccountUsage | undefined {
  let windows: ProviderUsageWindow[] = [];
  if (provider === "claude") {
    windows = ([["five_hour", "primary", 300], ["seven_day", "secondary", 10_080]] as const)
      .flatMap(([key, id, windowMinutes]) => {
        const row = input?.[key];
        const resetsAt = timestamp(row?.resets_at);
        return percent(row?.utilization) && resetsAt > now
          ? [{ id, usedPercent: row.utilization, windowMinutes, resetsAt }] : [];
      });
  } else {
    const start = timestamp(provider === "cursor" ? input?.currentPeriodStart : input?.config?.currentPeriod?.start);
    const resetsAt = timestamp(provider === "cursor" ? input?.nextResetTimestampUtc : input?.config?.currentPeriod?.end);
    const usedPercent = provider === "cursor" ? input?.usagePercent : input?.config?.creditUsagePercent;
    if (percent(usedPercent) && Number.isFinite(start) && start <= now && resetsAt > now && resetsAt > start) {
      const windowMinutes = Math.ceil((resetsAt - start) / 60_000);
      if (Number.isSafeInteger(windowMinutes) && windowMinutes > 0) {
        windows = [{ id: "primary", usedPercent, windowMinutes, resetsAt }];
      }
    }
  }
  return windows.length ? { provider, limitId: provider, observedAt: now, windows } : undefined;
}

/**
 * Limits narrower than the whole account. Claude reports a weekly limit for one model beside the
 * account-wide windows; each becomes its own report, named after the model, so the phone can show
 * it without mistaking it for the account's limit. Only the name and the share cross the wire.
 */
export function projectScopedLimits(provider: NativeUsageProvider, input: any, now = Date.now()): ProviderAccountUsage[] {
  if (provider !== "claude" || !Array.isArray(input?.limits)) return [];
  const reports = new Map<string, ProviderAccountUsage>();
  for (const limit of input.limits.slice(0, 16)) {
    const name = typeof limit?.scope?.model?.display_name === "string" ? limit.scope.model.display_name.trim().slice(0, 40) : "";
    const slug = name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const resetsAt = timestamp(limit?.resets_at);
    if (limit?.kind !== "weekly_scoped" || !name || !slug || !percent(limit.percent) || !(resetsAt > now)) continue;
    reports.set(slug, { provider, limitId: `${provider}:model:${slug}`, label: name, observedAt: now,
      windows: [{ id: "secondary", usedPercent: limit.percent, windowMinutes: 10_080, resetsAt }] });
  }
  return [...reports.values()].slice(0, 4);
}

/** Older Cursor plans report a billing-period pool rather than a weekly pool. */
export function projectCursorPeriodUsage(input: any, now = Date.now()): ProviderAccountUsage | undefined {
  const start = Number(input?.billingCycleStart), end = Number(input?.billingCycleEnd);
  const plan = input?.planUsage;
  const usedPercent = percent(plan?.totalPercentUsed) ? plan.totalPercentUsed
    : Number.isFinite(plan?.totalSpend) && plan.totalSpend >= 0 && Number.isFinite(plan?.limit) && plan.limit > 0
      ? plan.totalSpend / plan.limit * 100 : undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start
    || start > 8.64e15 || end > 8.64e15) return undefined;
  return projectNativeAccountUsage("cursor", { usagePercent: usedPercent,
    currentPeriodStart: new Date(start).toISOString(), nextResetTimestampUtc: new Date(end).toISOString() }, now);
}
