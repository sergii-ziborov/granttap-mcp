/** Keep the complete capability status, including totals, within the wire budget. */
import type { CapabilityUsageStatus, RemoteCapabilityUsageEvent } from "../../../../../packages/protocol/schema";

export const MAX_CAPABILITY_USAGE_EVENTS = 200;
export const MAX_CAPABILITY_USAGE_CANDIDATES = MAX_CAPABILITY_USAGE_EVENTS * 2;
export const MAX_CAPABILITY_USAGE_PAYLOAD_BYTES = 48 * 1024;
const MAX_TOKEN_ESTIMATE = 100_000;

function richness(event: RemoteCapabilityUsageEvent): number {
  return (event.durationMs != null ? 4 : 0) + (event.outcome !== "unknown" ? 4 : 0) +
    (event.resource != null ? 3 : 0) +
    (event.estimatedBaselineTokens != null ? 2 : 0) +
    (event.commandPreview != null ? 1 : 0) +
    (event.estimatedContextTokens ?? 0) / MAX_TOKEN_ESTIMATE;
}

export function limitCapabilityUsageEvents(
  events: RemoteCapabilityUsageEvent[],
  envelope: Omit<CapabilityUsageStatus, "events"> = {
    type: "capability.usage.status", generatedAt: Date.now(),
  },
): RemoteCapabilityUsageEvent[] {
  const bySource = new Map<string, RemoteCapabilityUsageEvent>();
  for (const event of events) {
    const key = `${event.roomId ?? ""}\u0000${event.agent ?? ""}\u0000${event.sessionId ?? ""}\u0000${event.sourceId}`;
    const previous = bySource.get(key);
    if (!previous || richness(event) > richness(previous)) bySource.set(key, event);
  }
  const sorted = [...bySource.values()].sort((a, b) => b.createdAt - a.createdAt);
  const out: RemoteCapabilityUsageEvent[] = [];
  let bytes = Buffer.byteLength(
    JSON.stringify({ ...envelope, events: [] }),
    "utf8",
  );
  for (const event of sorted) {
    if (out.length >= MAX_CAPABILITY_USAGE_EVENTS) break;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + (out.length ? 1 : 0);
    if (bytes + eventBytes > MAX_CAPABILITY_USAGE_PAYLOAD_BYTES) break;
    out.push(event);
    bytes += eventBytes;
  }
  return out;
}

export function rememberCapabilityUsageCandidate(
  candidates: RemoteCapabilityUsageEvent[],
  event: RemoteCapabilityUsageEvent,
): void {
  candidates.push(event);
  if (candidates.length < MAX_CAPABILITY_USAGE_CANDIDATES) return;
  const compacted = limitCapabilityUsageEvents(candidates);
  candidates.splice(0, candidates.length, ...compacted);
}
