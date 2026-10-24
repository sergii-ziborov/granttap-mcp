import assert from "node:assert/strict";
import test from "node:test";
import { createNativeAccountUsageReader } from "../reader";

const start = "2026-10-22T07:34:33.617Z", end = "2026-10-29T07:34:33.617Z";
const at = Date.parse("2026-10-24T08:00:00Z");

test("native reads coalesce and throttle independently without returning credentials or raw responses", async () => {
  let now = at;
  const calls: { url: string; init: RequestInit }[] = [];
  const reader = createNativeAccountUsageReader({ clock: () => now,
    credential: async provider => provider === "claude" ? undefined : `private-${provider}`,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json(url.includes("cursor.sh")
        ? { currentPeriodStart: start, nextResetTimestampUtc: end, usagePercent: 17.569, email: "private" }
        : { config: { currentPeriod: { start, end }, creditUsagePercent: 17, prepaidBalance: 400 } });
    },
  });
  assert.deepEqual(reader.current(), []);
  await Promise.all([reader.refresh(), reader.refresh()]);
  assert.equal(calls.length, 2);
  assert.deepEqual(reader.current().map(x => x.provider), ["cursor", "grok"]);
  assert.equal(calls.find(x => x.url.includes("cursor.sh"))?.init.method, "POST");
  assert.equal(calls.find(x => x.url.includes("grok.com"))?.init.method, "GET");
  assert.equal(JSON.stringify(reader.current()).includes("private"), false);
  await reader.refresh();
  assert.equal(calls.length, 2);
  now += 301_000;
  assert.deepEqual(reader.current(), []);
  await reader.refresh();
  assert.equal(calls.length, 4);
});

test("one provider failure never suppresses another; expired windows disappear without a fake reset", async () => {
  let now = at, fail = false;
  const reader = createNativeAccountUsageReader({ clock: () => now, credential: async () => "private",
    fetcher: async url => {
      if (url.includes("cursor.sh")) throw Error("offline");
      if (url.includes("grok.com")) return new Response("not signed in", { status: 401 });
      return fail ? new Response("bad json") : Response.json({
        five_hour: { utilization: 30, resets_at: new Date(at + 180_000).toISOString() },
      });
    },
  });
  await reader.refresh();
  assert.equal(reader.current()[0]?.windows[0]?.usedPercent, 30);
  now += 181_000;
  assert.deepEqual(reader.current(), []);
  fail = true;
  await reader.refresh();
  assert.deepEqual(reader.current(), []);
});

test("logout and oversized responses clear reports instead of inventing full allowances", async () => {
  let now = at, token: string | undefined = "private", large = false;
  const reader = createNativeAccountUsageReader({ clock: () => now, credential: async () => token,
    fetcher: async url => url.includes("anthropic") ? Response.json({ seven_day: { utilization: 55, resets_at: end } })
      : new Response(large ? " ".repeat(100_000) : "{}"),
  });
  await reader.refresh();
  assert.equal(reader.current()[0]?.windows[0]?.usedPercent, 55);
  now += 121_000; token = undefined;
  await reader.refresh();
  assert.deepEqual(reader.current(), []);
  now += 121_000; token = "changed"; large = true;
  await reader.refresh();
  assert.equal(reader.current().length, 1);
});

test("Cursor falls back to its native billing period when no weekly percentage is reported", async () => {
  const calls: string[] = [];
  const reader = createNativeAccountUsageReader({ clock: () => at,
    credential: async provider => provider === "cursor" ? "private" : undefined,
    fetcher: async url => {
      calls.push(url);
      return Response.json(url.endsWith("GetCurrentPeriodUsage") ? {
        billingCycleStart: String(Date.parse(start)), billingCycleEnd: String(Date.parse(end)),
        planUsage: { totalSpend: 25, limit: 100 },
      } : { includedLimitZero: true });
    },
  });
  await reader.refresh();
  assert.equal(calls.length, 2);
  assert.equal(reader.current()[0]?.windows[0]?.usedPercent, 25);
});
