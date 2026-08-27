import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteCapabilityUsageEvent } from "../packages/protocol/schema";
import {
  MAX_NAMES_PER_WINDOW,
  capabilityUsageTotals,
  createCapabilityTotals,
} from "../apps/bridge/src/sessions/capability-totals";
import { limitCapabilityUsageEvents } from "../apps/bridge/src/sessions/telemetry";

const now = 1_800_000_000_000;
const hour = 3_600_000;

function event(
  index: number,
  overrides: Partial<RemoteCapabilityUsageEvent> = {},
): RemoteCapabilityUsageEvent {
  return {
    sourceId: `source-${index}`,
    sessionId: "claude-session",
    kind: "cli",
    name: "Bash",
    toolName: "Bash",
    createdAt: now - index * 1_000,
    outcome: "success",
    ...overrides,
  };
}

test("a capability used days ago still counts once the feed is trimmed", () => {
  // A busy computer: thousands of shell calls in the last hours, and one skill
  // two days back. The transport keeps only the newest events.
  const events = [
    ...Array.from({ length: 2_000 }, (_, index) => event(index)),
    event(9_999, {
      kind: "skill", name: "release-check", toolName: "Skill",
      createdAt: now - 48 * hour,
    }),
  ];
  const trimmed = limitCapabilityUsageEvents([...events]);
  assert.ok(trimmed.length < events.length, "the published feed is bounded");
  assert.equal(
    trimmed.some((item) => item.kind === "skill"), false,
    "the skill is exactly what the budget drops",
  );

  const totals = capabilityUsageTotals(events, now);
  const weekSkills = totals.find((row) =>
    row.windowHours === 7 * 24 && row.kind === "skill" && row.name == null);
  assert.equal(weekSkills?.count, 1, "the week still knows the skill ran");
  const daySkills = totals.find((row) =>
    row.windowHours === 24 && row.kind === "skill" && row.name == null);
  assert.equal(daySkills, undefined, "and yesterday's window does not claim it");
});

test("totals separate outcomes, windows, and keep the busiest names", () => {
  const totals = createCapabilityTotals(now);
  totals.add(event(1, { outcome: "error" }));
  totals.add(event(2, { outcome: "cancelled" }));
  totals.add(event(3));
  totals.add(event(4, { kind: "mcp", name: "granttap", toolName: "notify" }));
  for (let index = 0; index < MAX_NAMES_PER_WINDOW + 5; index += 1) {
    totals.add(event(100 + index, { kind: "cli", name: `tool-${index}`, toolName: `tool-${index}` }));
  }
  const rows = totals.rows();
  const day = rows.filter((row) => row.windowHours === 24);
  const cli = day.find((row) => row.kind === "cli" && row.name == null);
  assert.equal(cli?.count, 3 + MAX_NAMES_PER_WINDOW + 5, "the roll-up counts every call");
  assert.equal(cli?.failures, 1);
  assert.equal(cli?.cancelled, 1);
  assert.equal(day.find((row) => row.name === "Bash")?.count, 3);
  assert.equal(day.filter((row) => row.name != null).length, MAX_NAMES_PER_WINDOW);
  assert.equal(
    rows.filter((row) => row.windowHours === 30 * 24 && row.kind === "mcp" && row.name == null)
      .at(0)?.count,
    1,
  );
});
