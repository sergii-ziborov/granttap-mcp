import assert from "node:assert/strict";
import test from "node:test";
import { projectCursorPeriodUsage, projectNativeAccountUsage } from "../projection";

const now = Date.parse("2026-10-24T08:00:00Z");
const start = "2026-10-22T07:34:33.617Z";
const end = "2026-10-29T07:34:33.617Z";

test("Cursor and Grok publish native account percentages and the reported reset period", () => {
  const cursor = projectNativeAccountUsage("cursor", {
    currentPeriodStart: start, nextResetTimestampUtc: end, usagePercent: 17.569,
    isUnified: true, email: "private", availableBankedResetCount: "5",
  }, now);
  const grok = projectNativeAccountUsage("grok", { config: {
    creditUsagePercent: 17, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
    prepaidBalance: 400, topUpMethod: "private",
  } }, now);
  assert.deepEqual(cursor, { provider: "cursor", limitId: "cursor", observedAt: now,
    windows: [{ id: "primary", usedPercent: 17.569, windowMinutes: 10_080, resetsAt: Date.parse(end) }] });
  assert.equal(grok?.windows[0]?.usedPercent, 17);
  assert.equal(grok?.windows[0]?.windowMinutes, 10_080);
  assert.equal(JSON.stringify([cursor, grok]).includes("private"), false);
  assert.equal(JSON.stringify(grok).includes("prepaidBalance"), false);
});

test("Claude accepts independently present OAuth subscription windows without inventing missing data", () => {
  const value = projectNativeAccountUsage("claude", {
    five_hour: { utilization: 99.5, resets_at: end }, seven_day: null,
    extra_usage: { utilization: 23, used_credits: 42 },
  }, now);
  assert.deepEqual(value?.windows, [{ id: "primary", usedPercent: 99.5,
    windowMinutes: 300, resetsAt: Date.parse(end) }]);
  assert.deepEqual(projectNativeAccountUsage("claude", {
    seven_day: { utilization: 0, resets_at: end },
  }, now)?.windows.map(x => [x.id, x.usedPercent]), [["secondary", 0]]);
});

test("missing, expired, negative, over-limit and partial periods remain unknown", () => {
  for (const provider of ["claude", "cursor", "grok"] as const) {
    for (const value of [null, {}, { config: {} }]) {
      assert.equal(projectNativeAccountUsage(provider, value, now), undefined);
    }
  }
  for (const used of [-1, 101, NaN, Infinity, "20", undefined]) {
    assert.equal(projectNativeAccountUsage("cursor", {
      currentPeriodStart: start, nextResetTimestampUtc: end, usagePercent: used,
    }, now), undefined);
    assert.equal(projectNativeAccountUsage("claude", {
      five_hour: { utilization: used, resets_at: end },
    }, now), undefined);
  }
  for (const period of [{ start }, { start, end: start }, { start: end, end: start },
    { start: "invalid", end }, { start, end: "2026-10-23T00:00:00Z" }]) {
    assert.equal(projectNativeAccountUsage("grok", {
      config: { creditUsagePercent: 20, currentPeriod: period },
    }, now), undefined);
  }
  assert.equal(projectNativeAccountUsage("claude", {
    five_hour: { utilization: 50, resets_at: start },
  }, now), undefined);
});

test("legacy Cursor uses its reported billing period and allowance, never a guessed plan price", () => {
  const dates = { billingCycleStart: String(Date.parse(start)), billingCycleEnd: String(Date.parse(end)) };
  assert.equal(projectCursorPeriodUsage({ ...dates, planUsage: { totalPercentUsed: 0 } }, now)?.windows[0]?.usedPercent, 0);
  assert.equal(projectCursorPeriodUsage({ ...dates, planUsage: { totalSpend: 25, limit: 100 } }, now)?.windows[0]?.usedPercent, 25);
  for (const value of [null, {}, { ...dates, planUsage: { totalSpend: 25 } },
    { ...dates, planUsage: { totalSpend: 25, limit: 0 } },
    { ...dates, billingCycleEnd: "Infinity", planUsage: { totalPercentUsed: 25 } },
    { ...dates, billingCycleEnd: 9e15, planUsage: { totalPercentUsed: 25 } }]) {
    assert.equal(projectCursorPeriodUsage(value, now), undefined);
  }
});

test("Claude's weekly limit for one model is published beside the account-wide windows, under that model's name", async () => {
  const { projectScopedLimits } = await import("../projection");
  const now = Date.parse("2026-11-14T06:00:00Z"), resets = "2026-11-16T11:00:00.719684+00:00";
  const input = { seven_day: { utilization: 12, resets_at: resets }, limits: [
    { kind: "weekly_all", group: "weekly", percent: 12, severity: "normal", resets_at: resets, scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 31.5, severity: "normal", resets_at: resets,
      scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ] };
  assert.deepEqual(projectScopedLimits("claude", input, now), [{ provider: "claude", limitId: "claude:model:fable", label: "Fable",
    observedAt: now, windows: [{ id: "secondary", usedPercent: 31.5, windowMinutes: 10_080, resetsAt: Date.parse(resets) }] }]);
  assert.deepEqual(projectNativeAccountUsage("claude", input, now)?.windows.map(window => window.id), ["secondary"],
    "the account-wide report is unchanged");
  const odd = { limits: [
    { kind: "weekly_scoped", percent: 140, resets_at: resets, scope: { model: { display_name: "Too much" } } },
    { kind: "weekly_scoped", percent: 10, resets_at: "2020-01-01T00:00:00Z", scope: { model: { display_name: "Past" } } },
    { kind: "weekly_scoped", percent: 10, resets_at: resets, scope: { model: { display_name: "  " } } },
    { kind: "weekly_scoped", percent: 10, resets_at: resets, scope: { surface: "desktop" } },
    { kind: "weekly_scoped", percent: 10, resets_at: resets, scope: { model: { display_name: "Opus 5.5 (preview) <b>" } } },
  ] };
  assert.deepEqual(projectScopedLimits("claude", odd, now).map(report => [report.limitId, report.label]),
    [["claude:model:opus-5.5-preview-b", "Opus 5.5 (preview) <b>"]], "only a named model with a real share and a future reset is published");
  assert.deepEqual(projectScopedLimits("grok", input, now), []);
  assert.deepEqual(projectScopedLimits("claude", { limits: "none" }, now), []);
});
