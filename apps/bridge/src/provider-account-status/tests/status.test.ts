import assert from "node:assert/strict";
import test from "node:test";
import { createProviderAccountReader, projectAccountModels, projectAccountUsage } from "../index";

test("account metadata excludes hidden models and all identity, instructions and credits", () => {
  assert.deepEqual(projectAccountModels({ data: [null, { model: "--bad" }, { model: "hidden", hidden: true },
    { model: "gpt-future", displayName: "Future", description: "Useful", instructions: "secret" }] }, "mac", 100),
  [{ modelId: "gpt-future", endpointId: "mac", provider: "codex", source: "advertised",
    label: "Future", description: "Useful", priority: 0, observedAt: 100 }]);
  const usage = projectAccountUsage({ accountId: "secret", rateLimits: { credits: "secret",
    primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 500 }, secondary: null } }, 100);
  assert.deepEqual(usage, [{ provider: "codex", limitId: "codex", observedAt: 100,
    windows: [{ id: "primary", usedPercent: 30, windowMinutes: 300, resetsAt: 500_000 }] }]);
  assert.deepEqual(projectAccountUsage(null, 100), []);
  assert.deepEqual(projectAccountUsage({ rateLimits: { primary: { usedPercent: 101 } } }, 100), []);
});

test("refresh coalesces, throttles, expires and keeps account failure separate from model availability", async () => {
  let now = 100;
  const calls: string[] = [];
  const reader = createProviderAccountReader(async method => {
    calls.push(method);
    if (method === "model/list") return { data: [{ model: "gpt-future" }] };
    throw Error("unavailable");
  }, () => now);
  assert.equal(reader.current("mac"), undefined);
  await Promise.all([reader.refresh("mac"), reader.refresh("mac")]);
  assert.equal(calls.length, 2);
  assert.equal(reader.current("mac")?.models[0]?.modelId, "gpt-future");
  assert.deepEqual(reader.current("mac")?.accountUsage, []);
  assert.equal(reader.current("foreign"), undefined);
  await reader.refresh("mac");
  assert.equal(calls.length, 2);
  now += 301_000;
  assert.equal(reader.current("mac"), undefined);
  await reader.refresh("mac");
  assert.equal(calls.length, 4);
});
