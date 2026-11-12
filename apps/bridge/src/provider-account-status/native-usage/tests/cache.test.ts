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

test("a Claude login is called lapsed only when Claude Code's own CLI agrees it is signed out", async () => {
  const { claudeLoginLapsed } = await import("..");
  assert.equal(await claudeLoginLapsed(async () => "expired", async () => "signed-out"), true);
  assert.equal(await claudeLoginLapsed(async () => "expired", async () => "signed-in"), false,
    "messages still run through the CLI, so the phone must not ask for a new sign-in");
  assert.equal(await claudeLoginLapsed(async () => "expired", async () => "unknown"), false);
  let asked = false;
  assert.equal(await claudeLoginLapsed(async () => "valid", async () => { asked = true; return "signed-out"; }), false);
  assert.equal(asked, false, "a usable saved login never spends a CLI run");
});
