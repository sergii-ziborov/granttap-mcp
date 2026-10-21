import type { CapabilityExecutionSummary, CapabilityUsageStatus, RemoteCapabilityUsageEvent } from '../../../../../packages/protocol/schema';
import { MAX_CAPABILITY_USAGE_PAYLOAD_BYTES } from './wire-budget';

/** Preserve execution attribution before recent call details are trimmed. */
export function createExecutionSummaries() {
  const rows = new Map<string, CapabilityExecutionSummary>();
  const seen = new Set<string>();
  return {
    add(event: RemoteCapabilityUsageEvent, source: 'native-history' | 'transcript') {
      if (event.kind === 'cli' || !event.sessionId || !event.agent) return;
      const identity = JSON.stringify([event.agent, event.sessionId, event.sourceId]);
      if (seen.has(identity)) return;
      seen.add(identity);
      const key = JSON.stringify([event.agent, event.sessionId, event.kind, event.name]);
      const row = rows.get(key) ?? { sessionId: event.sessionId, agent: event.agent,
        kind: event.kind, name: event.name, count: 0, failures: 0, cancelled: 0,
        lastUsedAt: 0, source };
      row.count++;
      row.failures += event.outcome === 'error' ? 1 : 0;
      row.cancelled += event.outcome === 'cancelled' ? 1 : 0;
      row.lastUsedAt = Math.max(row.lastUsedAt, event.createdAt);
      if (event.durationMs != null) {
        row.durationMs = (row.durationMs ?? 0) + event.durationMs;
        row.durationCount = (row.durationCount ?? 0) + 1;
      }
      rows.set(key, row);
    },
    rows: () => [...rows.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 128),
  };
}

export function budgetExecutionSummaries(rows: CapabilityExecutionSummary[],
  envelope: Omit<CapabilityUsageStatus, 'events' | 'executionSummaries'>): CapabilityExecutionSummary[] {
  const budget = Math.max(0, MAX_CAPABILITY_USAGE_PAYLOAD_BYTES - 8192
    - Buffer.byteLength(JSON.stringify({ ...envelope, events: [], executionSummaries: [] })));
  let bytes = 0;
  return rows.filter(row => {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > budget) return false;
    bytes += size;
    return true;
  }).slice(0, 128);
}
