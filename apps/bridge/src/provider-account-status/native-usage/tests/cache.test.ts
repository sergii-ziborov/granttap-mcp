import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAccountUsage } from "../../../../../../packages/protocol/schema";
import { mergeNativeUsage } from "../index";

test("status-line and direct Claude reads collapse to the newest real observation and retain other providers", () => {
  const now = 500_000;
  const row = (observedAt: number, provider: "claude" | "grok" = "claude"): ProviderAccountUsage => ({
    provider, limitId: provider, observedAt,
    windows: [{ id: "primary", usedPercent: 25, windowMinutes: 300, resetsAt: now + 100_000 }],
  });
  assert.deepEqual(mergeNativeUsage([row(now), row(now, "grok")], [row(now - 1)], now), [row(now), row(now, "grok")]);
  assert.deepEqual(mergeNativeUsage([row(now - 1)], [row(now)], now), [row(now)]);
  assert.deepEqual(mergeNativeUsage([row(now - 301_000), row(now + 61_000)], [], now), []);
  const expired = row(now); expired.windows[0]!.resetsAt = now;
  assert.deepEqual(mergeNativeUsage([expired], [], now), []);
});
