import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteCapabilityUsageEvent } from "../../packages/protocol/schema";
import {
  MAX_NAMES_PER_WINDOW,
  capabilityUsageTotals,
  createCapabilityTotals,
} from "../../apps/bridge/src/sessions/support/capability-totals";
import { limitCapabilityUsageEvents } from "../../apps/bridge/src/sessions/telemetry";

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
  // Each kind keeps its own busiest names: the one MCP row is not crowded out by shell commands.
  assert.equal(day.filter((row) => row.kind === "cli" && row.name != null).length, MAX_NAMES_PER_WINDOW);
  assert.equal(day.filter((row) => row.kind === "mcp" && row.name != null).length, 1);
  assert.equal(
    rows.filter((row) => row.windowHours === 30 * 24 && row.kind === "mcp" && row.name == null)
      .at(0)?.count,
    1,
  );
});

test("future observations do not enter a past or current half-open window", () => {
  const totals = capabilityUsageTotals([
    event(1, { createdAt: now - 1 }),
    event(2, { createdAt: now }),
    event(3, { createdAt: now + hour }),
  ], now);
  assert.equal(totals.find((row) => row.windowHours === 24
    && row.kind === "cli" && row.name == null)?.count, 1);
});

test("rarely used skills keep their own rows beside thousands of shell and MCP calls", () => {
  // A real week: dozens of busy CLI commands and MCP servers, and a few skills
  // called once or twice. A shared top-N handed every slot to the busy names,
  // so the phone's Skills filter read "No observed tool calls".
  const events: RemoteCapabilityUsageEvent[] = [];
  let index = 0;
  for (let name = 0; name < 30; name += 1) {
    for (let call = 0; call < 50; call += 1) events.push(event(index++, { name: `cli-${name}` }));
    for (let call = 0; call < 40; call += 1) {
      events.push(event(index++, { kind: "mcp", name: `server-${name}`, toolName: `mcp__server-${name}__run` }));
    }
  }
  events.push(event(index++, { kind: "skill", name: "chrome-browser", toolName: "Skill", createdAt: now - 30 * hour }));
  events.push(event(index++, { kind: "skill", name: "dataviz", toolName: "Skill", createdAt: now - 3 * 24 * hour }));

  const totals = capabilityUsageTotals(events, now);
  for (const windowHours of [7 * 24, 30 * 24]) {
    const skills = totals.filter(row => row.windowHours === windowHours && row.kind === "skill" && row.name);
    assert.deepEqual(skills.map(row => row.name).sort(), ["chrome-browser", "dataviz"], `${windowHours}h`);
  }
  const weekCli = totals.filter(row => row.windowHours === 7 * 24 && row.kind === "cli" && row.name);
  assert.ok(weekCli.length > 0 && weekCli.length <= MAX_NAMES_PER_WINDOW);
  assert.ok(totals.length <= 160, "the published totals stay inside the protocol limit");
});

test("a merged total and a counted event for the same name share one row", () => {
  const totals = createCapabilityTotals(now);
  totals.add(event(1, { kind: "skill", name: "dataviz", toolName: "Skill" }));
  totals.merge({ windowHours: 24, kind: "skill", name: "dataviz", count: 2, failures: 0, cancelled: 0, lastUsedAt: now - 5_000 });
  const rows = totals.rows().filter(row => row.windowHours === 24 && row.kind === "skill" && row.name === "dataviz");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.count, 3);
});
