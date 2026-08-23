import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CAPABILITY_OBSERVATIONS_PER_LOG,
  MAX_CAPABILITY_USAGE_CANDIDATES,
  MAX_CAPABILITY_USAGE_EVENTS,
  rememberCapabilityObservation,
  rememberCapabilityUsageCandidate,
  toRemoteCapabilityUsageEvent,
  type CapabilityObservation,
} from "../apps/bridge/src/sessions/telemetry";
import type { RemoteCapabilityUsageEvent } from "../packages/protocol/schema";

function observation(
  sourceId: string, createdAt: number, extra: Partial<CapabilityObservation> = {},
): CapabilityObservation {
  return {
    sourceId, sessionId: "session", toolName: "Bash", createdAt,
    cli: true, outcome: "success", ...extra,
  };
}

test("observations stay newest-first, deduplicated, and bounded per log", () => {
  const observations: CapabilityObservation[] = [];
  rememberCapabilityObservation(observations, observation("a", 100));
  rememberCapabilityObservation(observations, observation("b", 300));
  rememberCapabilityObservation(observations, observation("c", 200));
  assert.deepEqual(observations.map((item) => item.sourceId), ["b", "c", "a"]);

  rememberCapabilityObservation(observations, observation("a", 50));
  assert.equal(observations.filter((item) => item.sourceId === "a").length, 1);
  assert.equal(observations.find((item) => item.sourceId === "a")?.createdAt, 100);

  rememberCapabilityObservation(observations, observation("a", 400));
  assert.equal(observations[0]?.sourceId, "a");
  assert.equal(observations[0]?.createdAt, 400);

  for (let index = 0; index < MAX_CAPABILITY_OBSERVATIONS_PER_LOG + 20; index += 1) {
    rememberCapabilityObservation(observations, observation(`bulk-${index}`, 1_000 + index));
  }
  assert.equal(observations.length, MAX_CAPABILITY_OBSERVATIONS_PER_LOG);
});

test("only fully identified observations become remote usage events", () => {
  assert.equal(toRemoteCapabilityUsageEvent(observation("kindless", 1, { cli: undefined })), null);
  assert.equal(toRemoteCapabilityUsageEvent(observation("nameless", 1, { toolName: "  " })), null);
  const longSession = observation("long", 1, { sessionId: "s".repeat(257) });
  assert.equal(toRemoteCapabilityUsageEvent(longSession), null);
  assert.equal(toRemoteCapabilityUsageEvent(longSession), null, "a rejected observation is cached");

  const valid = observation("valid", 5, { mcpServer: "github", durationMs: 12 });
  const event = toRemoteCapabilityUsageEvent(valid);
  assert.equal(event?.kind, "mcp");
  assert.equal(event?.name, "github");
  assert.equal(toRemoteCapabilityUsageEvent(valid), event, "a valid observation is cached");
});

test("usage candidates compact to the richest bounded set", () => {
  const candidates: RemoteCapabilityUsageEvent[] = [];
  for (let index = 0; index < MAX_CAPABILITY_USAGE_CANDIDATES; index += 1) {
    const rich = index % 2 === 0;
    rememberCapabilityUsageCandidate(candidates, {
      sourceId: `source-${index}`, sessionId: "session", kind: "cli",
      name: "Bash", toolName: "Bash", createdAt: 1_000 + index,
      outcome: rich ? "success" : "unknown",
      ...(rich ? { durationMs: 25, estimatedContextTokens: 400 } : {}),
    } as RemoteCapabilityUsageEvent);
  }
  assert.ok(candidates.length <= MAX_CAPABILITY_USAGE_EVENTS,
    "compaction keeps the candidate buffer inside the event budget");
  assert.ok(candidates.some((event) => event.durationMs === 25));
});
