import assert from "node:assert/strict";
import test from "node:test";
import {
  limitCapabilityUsageEvents,
  toRemoteCapabilityUsageEvent,
} from "../apps/bridge/src/sessions/telemetry";
import {
  CapabilityUsageEvent,
  type RemoteCapabilityUsageEvent,
} from "../packages/protocol/schema";

const base = {
  sourceId: "session:call",
  sessionId: "session",
  kind: "mcp" as const,
  name: "github",
  toolName: "search_issues",
  createdAt: 1,
  outcome: "success" as const,
};

test("capability usage accepts bounded measured CPU and memory evidence", () => {
  const parsed = CapabilityUsageEvent.parse({
    ...base,
    resource: {
      attribution: "measured",
      cpuTimeMs: 24,
      cpuUserMs: 18,
      cpuSystemMs: 6,
      rssStartBytes: 80_000_000,
      rssEndBytes: 96_000_000,
      peakRssBytes: 112_000_000,
      memoryDeltaBytes: 16_000_000,
      childPeakRssBytes: 64_000_000,
      processCount: 3,
      ioReadBytes: 1_024,
      ioWriteBytes: 2_048,
      sampleWindowMs: 218,
    },
  });

  assert.equal(parsed.resource?.attribution, "measured");
  assert.equal(parsed.resource?.peakRssBytes, 112_000_000);
  assert.equal(parsed.resource?.cpuTimeMs, 24);
});

test("resource evidence stays optional and rejects impossible counters", () => {
  assert.equal(CapabilityUsageEvent.parse(base).resource, undefined);
  assert.equal(CapabilityUsageEvent.safeParse({
    ...base,
    resource: { attribution: "measured", peakRssBytes: -1 },
  }).success, false);
  assert.equal(CapabilityUsageEvent.safeParse({
    ...base,
    resource: { attribution: "guessed", cpuTimeMs: 1 },
  }).success, false);
  assert.equal(CapabilityUsageEvent.safeParse({
    ...base,
    resource: { attribution: "measured", cpuTimeMs: 31 * 24 * 60 * 60 * 1_000 },
  }).success, false);
});

test("event compaction retains the resource-enriched observation", () => {
  const bare: RemoteCapabilityUsageEvent = { ...base };
  const enriched: RemoteCapabilityUsageEvent = {
    ...base,
    resource: { attribution: "attributed", peakRssBytes: 112_000_000 },
  };

  assert.equal(limitCapabilityUsageEvents([bare, enriched])[0]?.resource?.peakRssBytes,
    112_000_000);
});

test("resource evidence survives observation projection", () => {
  const projected = toRemoteCapabilityUsageEvent({
    sourceId: "observed",
    sessionId: "session",
    toolName: "search_issues",
    createdAt: 1,
    mcpServer: "github",
    outcome: "success",
    resource: { attribution: "measured", cpuTimeMs: 24 },
  });

  assert.equal(projected?.resource?.cpuTimeMs, 24);
});
