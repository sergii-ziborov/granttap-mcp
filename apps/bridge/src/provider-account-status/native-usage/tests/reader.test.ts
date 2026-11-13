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
  assert.deepEqual(reader.current().map(x => x.observedAt), [at, at],
    "an older reading is still offered with the time it was really read; the phone marks it as needing an update");
  await reader.refresh();
  assert.equal(calls.length, 4);
  assert.deepEqual(reader.current().map(x => x.observedAt), [now, now]);
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

test("a refused or unreadable account read is reported once per reason, never with its credential", async () => {
  let now = at, status = 429;
  const notes: string[] = [];
  const reader = createNativeAccountUsageReader({ clock: () => now,
    credential: async provider => provider === "claude" ? "private-claude" : undefined,
    fetcher: async () => status === 200
      ? Response.json({ five_hour: { utilization: 30, resets_at: end }, seven_day: { utilization: 10, resets_at: end } })
      : new Response("slow down", { status }),
    report: (provider, reason) => notes.push(`${provider}:${reason ?? "available"}`),
  });
  await reader.refresh();
  now += 121_000; await reader.refresh();
  assert.deepEqual(notes.filter(note => note.startsWith("claude")), ["claude:HTTP 429"], "A repeated 429 is not logged again.");
  status = 200; now += 121_000; await reader.refresh();
  assert.deepEqual(reader.current().map(x => x.provider), ["claude"]);
  assert.deepEqual(notes.filter(note => note.startsWith("claude")), ["claude:HTTP 429", "claude:available"]);
  assert.equal(notes.join(" ").includes("private"), false);
  assert.deepEqual(notes.filter(note => note.startsWith("cursor")), [], "A provider that is not signed in is not a failure.");
});

test("a lapsed Claude login reports a signed-out marker, not silence, and says so once", async () => {
  const { isSignedOutUsage } = await import("../reader");
  const said: string[] = [];
  const reader = createNativeAccountUsageReader({ clock: () => at, credential: async () => undefined,
    expired: async provider => provider === "claude",
    fetcher: async () => { throw Error("no request is made without a login"); },
    report: (provider, reason) => said.push(`${provider}:${reason}`) });
  await reader.refresh();
  const current = reader.current();
  assert.deepEqual(current.map(report => report.limitId), ["claude:signed-out"]);
  assert.equal(isSignedOutUsage(current[0]!), true);
  assert.deepEqual(said, ["claude:the provider's console login has expired"]);
});

test("a failed read keeps the last good reading and is retried sooner, instead of blanking the limits", async () => {
  let now = at, status = 200, calls = 0;
  const reader = createNativeAccountUsageReader({ clock: () => now,
    credential: async provider => provider === "claude" ? "private" : undefined,
    fetcher: async () => { calls += 1; return status === 200
      ? Response.json({ five_hour: { utilization: 30, resets_at: end } }) : new Response("unavailable", { status }); } });
  await reader.refresh();
  status = 503; now += 121_000; await reader.refresh();
  const held = reader.current();
  assert.equal(held[0]?.windows[0]?.usedPercent, 30, "one 503 does not erase what was read two minutes ago");
  assert.equal(held[0]?.observedAt, at, "and it keeps the time it was really read");
  now += 21_000; status = 200; await reader.refresh();
  assert.equal(calls, 3, "a failed read is tried again after twenty seconds, not two minutes");
  assert.equal(reader.current()[0]?.observedAt, now);
});

test("the last good reading survives a restart and an access token Claude Code has yet to renew", async () => {
  let now = at;
  let stored: ReturnType<ReturnType<typeof createNativeAccountUsageReader>["current"]> = [];
  const saved = { read: () => stored, write: (reports: typeof stored) => { stored = reports; } };
  const first = createNativeAccountUsageReader({ clock: () => now, saved,
    credential: async provider => provider === "claude" ? "private" : undefined,
    fetcher: async () => Response.json({ seven_day: { utilization: 55, resets_at: end } }) });
  await first.refresh();
  assert.equal(stored.length, 1);
  assert.equal(JSON.stringify(stored).includes("private"), false, "numbers only, never the credential");
  now += 600_000;
  const said: string[] = [];
  const restarted = createNativeAccountUsageReader({ clock: () => now, saved, credential: async () => undefined,
    renewable: async provider => provider === "claude",
    fetcher: async () => { throw Error("no request is made without a token"); },
    report: (provider, reason) => said.push(`${provider}:${reason}`) });
  assert.equal(restarted.current()[0]?.windows[0]?.usedPercent, 55, "known before the first read after a restart");
  await restarted.refresh();
  assert.equal(restarted.current()[0]?.observedAt, at, "an access token awaiting renewal keeps the last reading");
  assert.deepEqual(said, ["claude:its saved access token has expired; the provider renews it on its next run"]);
  now += 25 * 3_600_000;
  assert.deepEqual(restarted.current(), [], "a day-old reading is no longer offered");
});
