import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityUsageStatus, Payload } from "../../schema";

const hour = 1_800_000_000_000;
const tokenUsage = {
  windows: [24, 168, 720].map((windowHours) => ({
    windowHours, tokens: 1_500,
    chats: [{ sessionId: "c0000000-0000-4000-8000-000000000001", agent: "claude", model: "claude-opus-4-7", tokens: 1_000 },
      { sessionId: "rollout", agent: "codex", tokens: 500 }],
    models: [{ agent: "claude", model: "claude-opus-4-7", tokens: 1_000 }],
  })),
  hours: [{ startedAt: hour, tokens: 500 }, { startedAt: hour + 3_600_000, tokens: 1_000 }],
};
const status = { type: "capability.usage.status", events: [], generatedAt: hour, tokenUsage };

test("a usage status carries when tokens were spent and where they went", () => {
  assert.equal(CapabilityUsageStatus.safeParse(status).success, true);
  assert.deepEqual(CapabilityUsageStatus.parse(status).tokenUsage, tokenUsage);
  assert.equal(Payload.parse(status).type, "capability.usage.status");
  const { tokenUsage: _absent, ...older } = status;
  assert.equal(CapabilityUsageStatus.safeParse(older).success, true, "a computer from before the field still reads");
});

test("token usage is strict and bounded", () => {
  const window = tokenUsage.windows[0]!;
  const invalid = [
    { ...tokenUsage, later: true },
    { ...tokenUsage, hours: [{ startedAt: hour, tokens: 1, model: "opus" }] },
    { ...tokenUsage, windows: [{ ...window, cost: 1 }] },
    { ...tokenUsage, windows: [{ ...window, chats: [{ ...window.chats[0]!, title: "secret" }] }] },
    { ...tokenUsage, windows: [{ ...window, models: [{ agent: "claude", model: "", tokens: 1 }] }] },
    { ...tokenUsage, windows: [{ ...window, windowHours: 48 }] },
    { ...tokenUsage, windows: [{ ...window, tokens: 1.5 }] },
    { ...tokenUsage, windows: [{ ...window, chats: [{ ...window.chats[0]!, tokens: -1 }] }] },
    { ...tokenUsage, windows: [{ ...window, chats: [{ ...window.chats[0]!, sessionId: "" }] }] },
    { ...tokenUsage, windows: [{ ...window, chats: Array.from({ length: 13 }, () => window.chats[0]!) }] },
    { ...tokenUsage, windows: [{ ...window, models: Array.from({ length: 17 }, () => window.models[0]!) }] },
    { ...tokenUsage, windows: [...tokenUsage.windows, window] },
    { ...tokenUsage, hours: Array.from({ length: 26 }, (_, index) => ({ startedAt: hour + index, tokens: 1 })) },
  ];
  for (const value of invalid) {
    assert.equal(CapabilityUsageStatus.safeParse({ ...status, tokenUsage: value }).success, false, JSON.stringify(value).slice(0, 120));
  }
});
