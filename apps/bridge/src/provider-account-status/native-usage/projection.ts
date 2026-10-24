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
